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
    if (!alpine?.directive || !alpine?.addScopeToNode || !alpine?.interceptInit || !alpine?.mutateDom) return false;
    const states = new WeakMap();
    const stateFor = element => {
        if (!states.has(element)) states.set(element, {scope: {}, names: new Map(), bindings: new Map()});
        return states.get(element);
    };
    const bindingName = /^(?:x-|@|:)/;
    const rewriteBindings = element => {
        const marker = element.getAttribute('x-mtc');
        const match = alpineMarker.exec(marker);
        const expressions = new Map();
        if (!match) return expressions;
        const [, template, ids] = match;
        const state = stateFor(element);
        if (state.marker !== marker) state.names.clear();
        state.marker = marker;
        state.template = template;
        state.bindings.clear();
        const statements = new Set(ids.split(','));
        const attributes = Array.from(element.attributes);
        for (const [index, attribute] of attributes.entries()) {
            if (!attribute.name.startsWith(alpineBindingMarker)) continue;
            const statement = attribute.name.slice(alpineBindingMarker.length);
            if (!statements.has(statement)) continue;
            const remembered = state.names.get(statement);
            const name = attribute.value || (remembered && element.hasAttribute(remembered)
                ? remembered : attributes[index - 1]?.name);
            if (!name || !bindingName.test(name) || !element.hasAttribute(name)) continue;
            state.names.set(statement, name);
            state.bindings.set(name, statement);
            const value = element.getAttribute(name);
            const loop = name === 'x-for' ? /^([\s\S]*?\s+(?:in|of)\s+)/.exec(value)?.[0] : '';
            if (loop === undefined) continue;
            // A bound evaluator can outlive a change to x-mtc. Its getter
            // follows the directive name to the current template and statement.
            const key = '__mtc_binding_' + Array.from(name, char => char.codePointAt(0).toString(16)).join('_');
            if (!Object.hasOwn(state.scope, key)) {
                Object.defineProperty(state.scope, key, {get() {
                    const current = state.bindings.get(name);
                    const live = element.getAttribute('x-mtc');
                    if (current !== undefined && live === state.marker &&
                        element.hasAttribute(alpineBindingMarker + current)) {
                        onHit(state.template, current);
                    }
                    return this;
                }});
            }
            const prefix = key + '.';
            expressions.set(name, value.startsWith(prefix, loop.length) ? value : loop + prefix + value.slice(loop.length));
        }
        return expressions;
    };
    alpine.interceptInit(element => {
        const bindings = rewriteBindings(element);
        if (!bindings.size) return;
        // Alpine reads DOM attributes on initial binding.
        alpine.mutateDom(() => {
            for (const [name, expression] of bindings) {
                if (element.getAttribute(name) !== expression) element.setAttribute(name, expression);
            }
        });
    });
    alpine.onAttributesAdded?.((element, attributes) => {
        if (!element.hasAttribute('x-mtc')) return;
        // Alpine has cleaned up the old directives. It snapshots the final
        // value in every record, so bind that value once per tracked attribute.
        const bindings = rewriteBindings(element);
        const seen = new Set();
        const active = attributes.filter(attribute => {
            const {name} = attribute;
            if (!bindings.has(name) && name !== 'x-mtc') return true;
            if (seen.has(name)) return false;
            seen.add(name);
            if (bindings.has(name)) attribute.value = bindings.get(name);
            return true;
        });
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
