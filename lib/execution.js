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
    const rewriteBindings = (element, update) => {
        const match = alpineMarker.exec(element.getAttribute('x-mtc'));
        if (!match) return;
        const [, template, ids] = match;
        const statements = new Set(ids.split(','));
        const attributes = Array.from(element.attributes);
        for (let index = 1; index < attributes.length; index++) {
            const name = attributes[index].name;
            if (!name.startsWith(alpineBindingMarker)) continue;
            const statement = name.slice(alpineBindingMarker.length);
            const binding = attributes[index - 1];
            if (!statements.has(statement) || !/^(?:x-|@|:)/.test(binding.name)) continue;
            const prefix = `__mtc_${template}_${statement}.`;
            const loop = binding.name === 'x-for'
                ? /^([\s\S]*?\s+(?:in|of)\s+)/.exec(binding.value)?.[0] : '';
            if (loop === undefined || binding.value.startsWith(prefix, loop.length)) continue;
            update(binding, loop + prefix + binding.value.slice(loop.length));
        }
    };
    alpine.interceptInit(element => {
        rewriteBindings(element, (binding, expression) => {
            // Rewrite before Alpine reads directives, without firing its attribute observer.
            alpine.mutateDom(() => { binding.value = expression; });
        });
    });
    alpine.onAttributesAdded?.((element, attributes) => {
        // Alpine reads these mutation records after this callback. Rewriting the
        // payload keeps a rebind instrumented without causing another mutation.
        rewriteBindings(element, (binding, expression) => {
            for (const attribute of attributes) {
                if (attribute.name === binding.name) attribute.value = expression;
            }
        });
    });
    alpine.directive('mtc', (element, {expression}, {cleanup}) => {
        const match = alpineMarker.exec(expression);
        if (!match) throw new Error('Invalid Alpine template coverage marker');
        const template = match[1];
        const scope = {};
        for (const statement of match[2].split(',')) {
            Object.defineProperty(scope, `__mtc_${template}_${statement}`, {
                get() { onHit(template, statement); return this; }
            });
        }
        cleanup(alpine.addScopeToNode(element, scope));
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
