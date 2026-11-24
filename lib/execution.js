// SPDX-FileCopyrightText: MageLens
// SPDX-License-Identifier: MIT
// License: see LICENSE in the repository root.

'use strict';

const windows = new WeakMap();
const { helper, alpineBindingMarker } = require('./engines-runtime');
const alpineMarker = /^([a-f0-9]{32}):([0-9,]+)$/;

function installJqueryTemplates(jquery) {
    if (!jquery?.tmpl?.tag) return false;
    if (jquery.tmpl.tag.mtc && jquery.tmpl.tag.mtc.open !== '$1;') {
        throw new Error('The jQuery template tag "mtc" is reserved for coverage');
    }
    jquery.tmpl.tag.mtc = { open: '$1;' };
    return true;
}

/** Instrument accessors AFTER Knockout parses expressions and creates property writers. */
function installKnockout(ko, onHit) {
    const provider = ko?.bindingProvider?.instance;
    if (!provider || typeof provider.parseBindingsString !== 'function') return false;
    const original = provider.parseBindingsString;
    provider.parseBindingsString = function (source, context, node, options) {
        const result = original.apply(this, arguments);
        const markers = [...source.matchAll(/\/\*mtc_([a-f0-9]{32})_(\d+)_([a-f0-9]+)\*\//g)];
        for (const [, template, statement, encoded] of markers) {
            const binding = decodeURIComponent(encoded.replace(/../g, part => `%${part}`));
            const key = binding === 'textinput' ? 'textInput' : binding;
            if (!Object.hasOwn(result, key)) {
                throw new Error(`Template coverage cannot track preprocessed binding: ${binding}`);
            }
            if (options?.valueAccessors) {
                const accessor = result[key];
                result[key] = function () {
                    onHit(template, statement);
                    return accessor.apply(this, arguments);
                };
            } else {
                // getBindings() evaluates its values eagerly inside the original provider.
                onHit(template, statement);
            }
        }
        return result;
    };
    return true;
}

/** Register before Alpine starts; no eval or generated functions are required. */
function installAlpine(alpine, onHit) {
    if (!alpine?.directive || !alpine?.addScopeToNode || !alpine?.interceptInit ||
        !alpine?.mapAttributes || !alpine?.onAttributesAdded || !alpine?.onAttributeRemoved) return false;
    const states = new WeakMap();
    const stateFor = element => {
        if (!states.has(element)) states.set(element, {scope: {}, bindings: new Map(), wrapped: new Set()});
        return states.get(element);
    };
    const updateBindings = (element, state) => {
        const marker = element.getAttribute('x-mtc');
        const match = alpineMarker.exec(marker);
        const previous = state.bindings;
        state.bindings = new Map();
        const sameMarker = state.marker === marker;
        state.marker = marker;
        if (!match) return;
        const [, template, ids] = match;
        state.template = template;
        for (const statement of ids.split(',')) {
            const markerName = alpineBindingMarker + statement;
            let name = element.getAttribute(markerName);
            if (name === null) continue;
            if (!name) {
                // Legacy output used empty markers and attribute adjacency.
                const remembered = sameMarker && [...previous].find(([, id]) => id === statement)?.[0];
                const names = element.getAttributeNames();
                const index = names.indexOf(markerName);
                name = remembered && element.hasAttribute(remembered) ? remembered : names[index - 1];
            }
            if (!name || name === 'x-mtc' || !/^(?:x-|@|:)/.test(name) || !element.hasAttribute(name)) continue;
            if (!state.bindings.has(name)) state.bindings.set(name, statement);
        }
    };
    const wrap = (element, state, name, value) => {
        const loop = name === 'x-for' ? /^([\s\S]*?\s+(?:in|of)\s+)/.exec(value)?.[0] : '';
        if (loop === undefined) return value;
        // A bound evaluator can outlive a change to x-mtc. Its getter
        // follows the directive name to the current template and statement.
        const key = '__mtc_binding_' + Array.from(name, char => char.codePointAt(0).toString(16)).join('_');
        if (!Object.hasOwn(state.scope, key)) {
            Object.defineProperty(state.scope, key, {get() {
                const current = state.bindings.get(name);
                if (current !== undefined && element.getAttribute('x-mtc') === state.marker) {
                    const liveName = element.getAttribute(alpineBindingMarker + current);
                    if ((liveName === name || liveName === '') && element.hasAttribute(name)) onHit(state.template, current);
                }
                return this;
            }});
        }
        if (!state.wrapped.has(name)) {
            state.wrapped.add(name);
            alpine.onAttributeRemoved(element, name, () => state.wrapped.delete(name));
        }
        return loop + key + '.' + value.slice(loop.length);
    };
    // Alpine sends the element to interceptInit, then immediately maps its
    // physical attributes without passing the element. Match that one list
    // so later mutation records and virtual bindings cannot reuse the plan.
    let initial;
    const expandedName = name => name.startsWith('@') ? 'x-on:' + name.slice(1)
        : name.startsWith(':') ? 'x-bind:' + name.slice(1) : name;
    alpine.interceptInit(element => {
        initial = undefined;
        if (!element.hasAttribute('x-mtc')) return;
        const state = stateFor(element);
        updateBindings(element, state);
        if (!state.bindings.size) return;
        const plan = {element, state, attributes: Array.from(element.attributes), index: 0};
        initial = plan;
        queueMicrotask(() => { if (initial === plan) initial = undefined; });
    });
    alpine.mapAttributes(attribute => {
        if (!initial) return attribute;
        const {element, state, attributes, index} = initial;
        const {name, value} = attributes[index];
        if (attribute.value !== value || (attribute.name !== name && attribute.name !== expandedName(name))) {
            if (index) initial = undefined;
            return attribute;
        }
        if (++initial.index === attributes.length) initial = undefined;
        if (!state.bindings.has(name)) return attribute;
        return {...attribute, value: wrap(element, state, name, value)};
    });
    alpine.onAttributesAdded((element, attributes) => {
        if (!states.has(element) && !element.hasAttribute('x-mtc')) return;
        const state = stateFor(element);
        const previous = state.bindings;
        updateBindings(element, state);
        // Alpine has cleaned up the old directives. Its snapshot can
        // contain the final value more than once, even after x-mtc is gone.
        const seen = new Set();
        const active = attributes.filter(attribute => {
            const {name} = attribute;
            if (!state.bindings.has(name) && !previous.has(name) && name !== 'x-mtc') return true;
            if (seen.has(name)) return false;
            seen.add(name);
            if (state.bindings.has(name)) attribute.value = wrap(element, state, name, attribute.value);
            return true;
        });
        for (const name of state.bindings.keys()) {
            if (seen.has(name) || state.wrapped.has(name) || !/^(?:x-on:|@)/.test(name)) continue;
            // Alpine keeps the cleanup even after a .once listener fires.
            // The marker alone cannot establish whether it is still active.
            if (name.split('.').slice(1).includes('once')) continue;
            // Markers alone do not cause a native rebind. Upgrade only an
            // existing listener, using the same attribute cleanup as Alpine.
            const cleanups = element._x_attributeCleanups;
            if (!cleanups?.[name]) continue;
            cleanups[name].forEach(cleanup => cleanup());
            delete cleanups[name];
            active.push({name, value: wrap(element, state, name, element.getAttribute(name))});
        }
        attributes.splice(0, attributes.length, ...active);
    });
    alpine.directive('mtc', (element, {expression}, {cleanup}) => {
        if (!alpineMarker.test(expression)) throw new Error('Invalid Alpine template coverage marker');
        cleanup(alpine.addScopeToNode(element, stateFor(element).scope));
    }).before('data');
    return true;
}

/** Attach before RequireJS consumers receive Knockout; never require application modules ourselves. */
function observeExecution(win, onHit) {
    let state = windows.get(win);
    // WindowProxy identity can survive navigation while its document/globals change.
    if (!state || state.document !== win.document) {
        state = { previousHelper: state && win[helper] === state.helper, document: win.document, onHit, modules: new WeakSet(), loaders: new WeakSet() };
        windows.set(win, state);
        if (win[helper] !== undefined && !state.previousHelper) throw new Error(`Template coverage global already exists: ${helper}`);
        Object.defineProperty(win, helper, { configurable: true, value(template, statement) {
            state.onHit?.(template, statement);
        } });
        state.helper = win[helper];
        const attach = module => {
            installJqueryTemplates(module);
            if (!module || (typeof module !== 'object' && typeof module !== 'function') || state.modules.has(module)) return;
            if (installKnockout(module, (template, statement) => state.onHit?.(template, statement))) state.modules.add(module);
        };
        const loader = requirejs => {
            if (typeof requirejs !== 'function' || state.loaders.has(requirejs)) return;
            state.loaders.add(requirejs);
            const wrap = callback => function (context, map) {
                attach(context.defined[map.id]);
                // Legacy plugins may return undefined and instead extend jQuery.
                attach(context.defined.jquery);
                attach(win.jQuery);
                return callback?.apply(this, arguments);
            };
            let current = wrap(requirejs.onResourceLoad);
            Object.defineProperty(requirejs, 'onResourceLoad', {
                configurable: true, enumerable: true,
                get() { return current; },
                set(value) { if (value !== current) current = wrap(value); }
            });
            for (const context of Object.values(requirejs.s?.contexts || {})) {
                for (const module of Object.values(context.defined)) attach(module);
            }
        };
        const watch = (key, consume) => {
            let value = win[key];
            consume(value);
            const descriptor = Object.getOwnPropertyDescriptor(win, key);
            if (descriptor && !descriptor.configurable) return;
            Object.defineProperty(win, key, {
                configurable: true, enumerable: descriptor?.enumerable ?? true,
                // UMD engines may publish an empty object, then populate it in place.
                // Attach on its first consumer read as well as assignment.
                get() { consume(value); return value; },
                set(next) { value = next; consume(next); }
            });
        };
        const alpine = module => {
            if (!module || state.modules.has(module)) return;
            if (installAlpine(module, (template, statement) => state.onHit?.(template, statement))) state.modules.add(module);
        };
        watch('Alpine', alpine);
        win.document.addEventListener('alpine:init', () => alpine(win.Alpine));
        watch('requirejs', loader);
        watch('ko', attach);
        watch('jQuery', attach);
    }
    if (win[helper] !== state.helper) {
        if (win[helper] !== undefined) {
            throw new Error(`Template coverage global already exists: ${helper}`);
        }

        Object.defineProperty(win, helper, {
            configurable: true,
            value: state.helper
        });
    }
    state.onHit = onHit;
    return { disconnect() { if (state.onHit === onHit) state.onHit = undefined; } };
}

module.exports = { installAlpine, installKnockout, installJqueryTemplates, observeExecution };
