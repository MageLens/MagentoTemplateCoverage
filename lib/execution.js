// SPDX-FileCopyrightText: MageLens
// SPDX-License-Identifier: MIT
// License: see LICENSE in the repository root.

'use strict';

const windows = new WeakMap();
const { helper, alpineBindingMarker, alpinePropertyPath } = require('./engines-runtime');
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
        !alpine?.mapAttributes || !alpine?.onAttributesAdded || !alpine?.evaluateLater) return false;
    const states = new WeakMap();
    const stateFor = element => {
        if (!states.has(element)) states.set(element, {scope: {}, bindings: new Map()});
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
    const recordHit = (element, state, name) => {
        const current = state.bindings.get(name);
        if (current === undefined || element.getAttribute('x-mtc') !== state.marker) return;
        const liveName = element.getAttribute(alpineBindingMarker + current);
        if ((liveName === name || liveName === '') && element.hasAttribute(name)) onHit(state.template, current);
    };
    const eventBinding = name => /^(?:x-on:|@)/.test(name);
    const lateBinding = (name, value) => (eventBinding(name) || name === 'x-text') && alpinePropertyPath.test(value);
    const shouldWrap = (state, name, value) => state.bindings.has(name) || lateBinding(name, value);
    const textResult = evaluate => {
        let synchronous = false, result, resolve;
        evaluate(value => {
            if (resolve) resolve(value);
            else {
                synchronous = true;
                result = value;
            }
        });
        if (!synchronous) return new Promise(settle => { resolve = settle; });
        // A returned function is the text value after Alpine has already
        // auto-called the original expression. Avoid auto-calling it again.
        return typeof result === 'function' ? {toString: () => String(result)} : result;
    };
    const wrap = (element, state, name, value, prepare) => {
        if (lateBinding(name, value)) {
            // Delegate the original expression to Alpine at native bind time.
            // It retains its own scope, globals, magic values and arguments.
            let evaluate;
            const event = eventBinding(name);
            prepare.push(() => { evaluate = alpine.evaluateLater(element, value); });
            return function (...params) {
                recordHit(element, state, name);
                evaluate ??= alpine.evaluateLater(element, value);
                if (!event) return textResult(evaluate);
                evaluate(() => {}, {scope: {$event: params[0]}, params});
            };
        }
        const loop = name === 'x-for' ? /^([\s\S]*?\s+(?:in|of)\s+)/.exec(value)?.[0] : '';
        if (loop === undefined) return value;
        // A bound evaluator can outlive a change to x-mtc. Its getter
        // follows the directive name to the current template and statement.
        const key = '__mtc_binding_' + Array.from(name, char => char.codePointAt(0).toString(16)).join('_');
        if (!Object.hasOwn(state.scope, key)) {
            Object.defineProperty(state.scope, key, {get() {
                recordHit(element, state, name);
                return this;
            }});
        }
        return loop + key + '.' + value.slice(loop.length);
    };

    // Arm ordinary property-path listeners and text effects at their native
    // bind. If markers arrive later, only the existing getter's credit changes.
    const scopeAttribute = 'x-mtc-scope';
    const scopeExpression = Symbol();
    const prepareAttribute = 'x-mtc-prepare';
    alpine.directive('mtc-prepare', (element, {expression}) => {
        if (Array.isArray(expression)) expression.forEach(prepare => prepare());
    }).before('on');
    alpine.directive('mtc-scope', (element, {expression}) => {
        if (expression !== scopeExpression) return;
        const state = stateFor(element);
        if (state.attached || !Object.getOwnPropertyNames(state.scope).length) return;
        // Alpine captures the scope when it binds each directive. Remove the
        // temporary layer afterwards so descendants still inherit live data.
        const previous = element._x_dataStack;
        const undo = alpine.addScopeToNode(element, state.scope);
        const attached = element._x_dataStack;
        state.attached = true;
        queueMicrotask(() => {
            if (element._x_dataStack === attached) {
                if (previous) element._x_dataStack = previous;
                else delete element._x_dataStack;
            } else if (element._x_dataStack) {
                undo();
            }
            state.attached = false;
        });
    }).before('data');

    // Alpine maps attributes without passing the element, expanding @ and :
    // first. Use the original names and values to match each physical binding.
    let initial;
    const expandedName = name => name.startsWith('@') ? 'x-on:' + name.slice(1)
        : name.startsWith(':') ? 'x-bind:' + name.slice(1) : name;
    alpine.interceptInit(element => {
        initial = undefined;
        const attributes = Array.from(element.attributes);
        if (!element.hasAttribute('x-mtc') && !attributes.some(({name, value}) => lateBinding(name, value))) return;
        const state = stateFor(element);
        updateBindings(element, state);
        if (!attributes.some(({name, value}) => shouldWrap(state, name, value))) return;
        const candidates = new Map();
        for (const {name} of attributes) {
            // Include aliases even if only one is instrumented; their native
            // canonical names can coincide, including with equal expressions.
            if (!/^(?:x-|@|:)/.test(name)) continue;
            const key = expandedName(name);
            if (!candidates.has(key)) candidates.set(key, []);
            candidates.get(key).push(name);
        }
        const previous = element._x_virtualDirectives;
        const prepare = [];
        element._x_virtualDirectives = {...previous, [prepareAttribute]: prepare, [scopeAttribute]: scopeExpression};
        const restore = () => {
            const virtual = element._x_virtualDirectives;
            if (virtual?.[scopeAttribute] !== scopeExpression) return;
            delete virtual[scopeAttribute];
            if (virtual[prepareAttribute] === prepare) delete virtual[prepareAttribute];
            if (!previous && !Object.keys(virtual).length) delete element._x_virtualDirectives;
        };
        const plan = {element, state, candidates, prepare, ready: false, restore};
        initial = plan;
        queueMicrotask(() => {
            if (initial === plan) initial = undefined;
            restore();
        });
    });
    alpine.mapAttributes(attribute => {
        if (!initial) return attribute;
        const {element, state, candidates, prepare, ready, restore} = initial;
        if (attribute.name === scopeAttribute && attribute.value === scopeExpression) {
            // Alpine classifies the virtual attributes before mapping the
            // actual directives. This sentinel is last in both passes.
            if (ready) {
                initial = undefined;
                restore();
            } else initial.ready = true;
            return attribute;
        }
        if (!ready) return attribute;
        const names = candidates.get(attribute.name);
        const index = names?.findIndex(name => element.getAttribute(name) === attribute.value) ?? -1;
        if (index < 0) return attribute;
        const [name] = names.splice(index, 1);
        return shouldWrap(state, name, attribute.value)
            ? {...attribute, value: wrap(element, state, name, attribute.value, prepare)} : attribute;
    });
    alpine.onAttributesAdded((element, attributes) => {
        if (!states.has(element) && !element.hasAttribute('x-mtc') &&
            !attributes.some(({name, value}) => lateBinding(name, value))) return;
        const state = stateFor(element);
        const previous = state.bindings;
        updateBindings(element, state);
        // Alpine has cleaned up changed directives. Coalesce their records
        // without touching any existing listener or effect on marker changes.
        const seen = new Set();
        const prepare = [];
        let needsScope = false;
        const active = attributes.filter(attribute => {
            const {name, value} = attribute;
            if (state.bindings.has(name) || previous.has(name) || name === 'x-mtc') {
                if (seen.has(name)) return false;
                seen.add(name);
            }
            if (shouldWrap(state, name, value)) {
                attribute.value = wrap(element, state, name, value, prepare);
                if (typeof attribute.value === 'string' && attribute.value !== value) needsScope = true;
            }
            return true;
        });
        if (needsScope) active.push({name: scopeAttribute, value: scopeExpression});
        if (prepare.length) active.push({name: prepareAttribute, value: prepare});
        attributes.splice(0, attributes.length, ...active);
    });
    alpine.directive('mtc', (element, {expression}) => {
        if (!alpineMarker.test(expression)) throw new Error('Invalid Alpine template coverage marker');
    });
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
