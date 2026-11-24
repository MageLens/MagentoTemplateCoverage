// SPDX-FileCopyrightText: MageLens
// SPDX-License-Identifier: MIT
// License: see LICENSE in the repository root.

'use strict';

const fs = require('node:fs');
const {test, expect} = require('@playwright/test');
const {analyzeStatements} = require('../../lib/statements');
const {browserSource} = require('../../lib/browser-source');

const cdn = fs.readFileSync(require.resolve('alpinejs').replace(/module.cjs.js$/, 'cdn.js'), 'utf8');
const morphdom = fs.readFileSync(require.resolve('morphdom/dist/morphdom-umd.js'), 'utf8');
const memo = 'var evaluatorMemo = {};';
const countedCdn = cdn.replace(memo, memo + '\nwindow.alpineMemoSize = () => Object.keys(evaluatorMemo).length;');
const origin = 'http://mtc-cache.test';
const site = '<!doctype html><script defer src="/alpine.js"></script>' +
    '<main x-data="{title: \'native\'}"><button id="warm" :title="title">Warm</button><div id="mount"></div></main>';
const globalBindingPage = site + `
    <script src="/morphdom.js"></script>
    <script>
        let displayState;
        document.addEventListener('alpine:init', () => {
            displayState = Alpine.reactive({title: 'global-1'});
            Alpine.directive('read-display-prop', element => {
                Alpine.extractProp(element, 'title');
            }).before('bind');
        });
        window.setDisplayTitle = title => { displayState.title = title; };
        window.morphDisplayParent = (button, data) => {
            const parent = button.parentElement;
            const replacement = parent.cloneNode(true);
            if (data === null) replacement.removeAttribute('x-data');
            else replacement.setAttribute('x-data', data);
            if (window.morphdom(parent, replacement) !== parent || !button.isConnected ||
                parent.firstElementChild !== button) throw new Error('Morph replaced the retained button');
        };
    </script>
    <section x-data>
        <div>
            <button id="bound-title" :title="displayState.title">Bound title</button>
            <button id="extracted-title" x-read-display-prop :title="displayState.title">Extracted title</button>
        </div>
    </section>`;

async function open(page, collect, markup = site) {
    expect(countedCdn).not.toBe(cdn);
    if (collect) await page.addInitScript({content: '(() => {' +
        'const hits = window.templateHits = {};\n' +
        browserSource() + '.observeExecution(window, (template, statement) => {' +
        'const key = template + ":" + statement; hits[key] = (hits[key] || 0) + 1; });' +
        '})()'});
    await page.route(origin + '/**', async route => {
        if (route.request().url() === origin + '/alpine.js') {
            await route.fulfill({contentType: 'application/javascript', body: countedCdn});
        } else if (route.request().url() === origin + '/morphdom.js') {
            await route.fulfill({contentType: 'application/javascript', body: morphdom});
        } else await route.fulfill({contentType: 'text/html', body: markup});
    });
    await page.goto(origin + '/');
    await expect(page.locator('#warm')).toHaveAttribute('title', 'native');
}

for (const collect of [true, false]) {
    test(`parent morphs preserve an existing binding and update a fresh prop read with collection ${collect}`, async ({page}) => {
        await open(page, collect, globalBindingPage);
        const bound = page.locator('#bound-title');
        const extracted = page.locator('#extracted-title');
        await expect(bound).toHaveAttribute('title', 'global-1');
        expect(await extracted.evaluate(button => Alpine.extractProp(button, 'title'))).toBe('global-1');
        await bound.evaluate(async button => {
            window.morphDisplayParent(button, "{displayState: {title: 'local'}}");
            await Alpine.nextTick();
        });
        expect(await extracted.evaluate(button => Alpine.extractProp(button, 'title'))).toBe('local');
        const titles = await bound.evaluate(async button => {
            const values = [];
            for (const title of ['global-2', 'global-3']) {
                window.setDisplayTitle(title);
                await Alpine.nextTick();
                values.push(button.title);
            }
            return values;
        });
        expect(titles).toEqual(['global-2', 'global-3']);
        expect(await extracted.evaluate(button => Alpine.extractProp(button, 'title'))).toBe('local');
    });

    test(`parent morphs keep global binding cleanup bounded with collection ${collect}`, async ({page}) => {
        await open(page, collect, globalBindingPage);
        const bound = page.locator('#bound-title');
        await expect(bound).toHaveAttribute('title', 'global-1');
        const growth = await bound.evaluate(async button => {
            const cleanups = () => button._x_cleanups?.length ?? 0;
            const before = cleanups();
            for (let index = 0; index < 100; index++) {
                window.morphDisplayParent(button, index % 2 ? null : '{}');
                await Alpine.nextTick();
                const title = 'updated-' + index;
                window.setDisplayTitle(title);
                await Alpine.nextTick();
                if (button.title !== title) throw new Error('The existing binding stopped tracking the global title');
            }
            return cleanups() - before;
        });
        expect(growth).toBe(0);
    });

    test(`an extracted prop follows its parent after a morph with collection ${collect}`, async ({page}) => {
        await open(page, collect, site + `
            <script src="/morphdom.js"></script>
            <script>
                const persistedLabel = 'global';
                document.addEventListener('alpine:init', () => {
                    const component = Alpine.reactive({});
                    Alpine.data('propParent', () => component);
                    Alpine.directive('read-prop', element => {
                        window.initialProp = Alpine.extractProp(element, 'title');
                    }).before('bind');
                    window.setParentLabel = () => { component.persistedLabel = 'component'; };
                });
            </script>
            <section x-data>
                <div id="prop-parent" x-data="propParent">
                    <button id="prop-child" x-read-prop :title="persistedLabel">Extracted prop</button>
                </div>
            </section>
        `);
        const child = page.locator('#prop-child');
        expect(await page.evaluate(() => window.initialProp)).toBe('global');
        await page.evaluate(() => window.setParentLabel());
        expect(await child.evaluate(element => Alpine.extractProp(element, 'title'))).toBe('component');
        const after = await child.evaluate(async element => {
            const parent = element.parentElement;
            const replacement = parent.cloneNode(true);
            replacement.removeAttribute('x-data');
            window.morphdom(parent, replacement);
            await Alpine.nextTick();
            return {
                retained: parent.firstElementChild === element && !parent.hasAttribute('x-data'),
                binding: element.getAttribute(':title'),
                fresh: Alpine.evaluate(element, 'persistedLabel'),
                extracted: Alpine.extractProp(element, 'title')
            };
        });
        expect(after).toEqual({retained: true, binding: 'persistedLabel', fresh: 'global', extracted: 'global'});
    });

    test(`a morphed binding forgets its removed component scope with collection ${collect}`, async ({page}) => {
        await open(page, collect, site + `
            <script src="/morphdom.js"></script>
            <script>
                const reviewLabel = 'global';
                document.addEventListener('alpine:init', () => {
                    const component = Alpine.reactive({});
                    Alpine.data('reviewComponent', () => component);
                    window.overrideReviewLabel = () => { component.reviewLabel = 'component'; };
                });
            </script>
            <section x-data>
                <button id="retained" x-data="reviewComponent" :title="reviewLabel">Retained</button>
            </section>
        `);
        const button = page.locator('#retained');
        await expect(button).toHaveAttribute('title', 'global');
        await page.evaluate(() => window.overrideReviewLabel());
        await expect(button).toHaveAttribute('title', 'component');
        await button.evaluate(element => {
            const original = '<button id="retained">Retained</button>';
            const rebound = '<button id="retained" :title="reviewLabel">Retained</button>';
            for (const markup of [original, rebound]) {
                if (window.morphdom(element, markup) !== element) throw new Error('Morph replaced the button');
            }
        });
        await expect(button).not.toHaveAttribute('x-data');
        await expect(button).toHaveAttribute('title', 'global', {timeout: 2000});
    });

    test(`promised global bindings reach the DOM with collection ${collect}`, async ({page}) => {
        await open(page, collect, site + `
            <script>
                const deferredTitle = new Promise(resolve => { window.resolveTitle = resolve; });
                const deferredState = new Promise(() => {});
                deferredState.title = deferredTitle;
            </script>
            <section x-data>
                <button id="deferred" :title="deferredTitle">Deferred</button>
                <button id="deferred-property" :title="deferredState.title">Deferred property</button>
            </section>
        `);
        const button = page.locator('#deferred');
        const property = page.locator('#deferred-property');
        await expect(button).not.toHaveAttribute('title');
        await expect(property).not.toHaveAttribute('title');
        await page.evaluate(() => window.resolveTitle('arrived'));
        await expect(button).toHaveAttribute('title', 'arrived', {timeout: 2000});
        await expect(property).toHaveAttribute('title', 'arrived', {timeout: 2000});
    });

    test(`reactive global bindings keep bounded element cleanup with collection ${collect}`, async ({page}) => {
        await open(page, collect, site + `
            <script>
                let lexicalReviewState;
                document.addEventListener('alpine:init', () => {
                    lexicalReviewState = Alpine.reactive({title: 'initial'});
                    window.reviewState = lexicalReviewState;
                });
            </script>
            <section x-data>
                <button id="global" :title="window.reviewState.title">Global</button>
                <button id="lexical" :title="lexicalReviewState.title">Lexical</button>
            </section>
        `);
        const bindings = page.locator('#global, #lexical');
        await expect(bindings.first()).toHaveAttribute('title', 'initial');
        await expect(bindings.last()).toHaveAttribute('title', 'initial');
        const result = await bindings.evaluateAll(async buttons => {
            const cleanups = () => buttons.map(button => button._x_cleanups?.length ?? 0);
            const before = cleanups();
            for (let index = 1; index <= 100; index++) {
                const title = 'global ' + index;
                window.reviewState.title = title;
                await Alpine.nextTick();
                if (buttons.some(button => button.title !== title)) throw new Error('A reactive title did not update');
            }
            return cleanups().map((count, index) => count - before[index]);
        });
        expect(result).toEqual([0, 0]);
    });

    test('repeated Alpine bindings reuse evaluator cache entries with collection ' + collect, async ({page}) => {
        await open(page, collect);
        const growth = await page.locator('#mount').evaluate(async mount => {
            const settle = () => new Promise(resolve => requestAnimationFrame(resolve));
            const before = window.alpineMemoSize();
            const sizes = [];
            for (let batch = 0; batch < 3; batch++) {
                mount.innerHTML = '<button :title="title">Short-lived button</button>'.repeat(100);
                await settle();
                if ([...mount.children].some(button => button.title !== 'native')) {
                    throw new Error('The batch did not bind its native titles');
                }
                mount.replaceChildren();
                await settle();
                sizes.push(window.alpineMemoSize() - before);
            }
            return sizes;
        });
        expect(growth).toEqual([0, 0, 0]);
    });
}

test('identical expressions attribute nested Alpine bindings to their own elements', async ({page}) => {
    const parent = 'a'.repeat(32), child = 'b'.repeat(32);
    const outer = analyzeStatements('<div id="outer" :title="title"></div>', parent, 'alpine');
    const inner = analyzeStatements('<button id="inner" :title="title">Inner</button>', child, 'alpine');
    await open(page, true);
    const warmedSize = await page.evaluate(() => window.alpineMemoSize());
    await page.locator('#mount').evaluate((mount, {outer, inner}) => {
        const incoming = new DOMParser().parseFromString(outer, 'text/html').querySelector('#outer');
        incoming.innerHTML = inner;
        mount.append(incoming);
    }, {outer: outer.content, inner: inner.content});
    await expect(page.locator('#outer')).toHaveAttribute('title', 'native');
    await expect(page.locator('#inner')).toHaveAttribute('title', 'native');
    expect(await page.evaluate(() => window.alpineMemoSize())).toBe(warmedSize);
    const keys = [parent + ':' + outer.statements[0].id, child + ':' + inner.statements[0].id];
    const counts = await page.evaluate(keys => keys.map(key => window.templateHits[key] ?? 0), keys);
    expect(counts.every(count => count > 0)).toBe(true);
    await page.locator('#inner').evaluate(element => Alpine.$data(element).title = 'updated');
    await expect(page.locator('#inner')).toHaveAttribute('title', 'updated');
    await expect(page.locator('#outer')).toHaveAttribute('title', 'updated');
    const updated = await page.evaluate(keys => keys.map(key => window.templateHits[key] ?? 0), keys);
    expect(updated[0]).toBeGreaterThan(counts[0]);
    expect(updated[1]).toBeGreaterThan(counts[1]);
});
