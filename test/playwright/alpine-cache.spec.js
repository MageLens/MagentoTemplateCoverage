// SPDX-FileCopyrightText: MageLens
// SPDX-License-Identifier: MIT
// License: see LICENSE in the repository root.

'use strict';

const fs = require('node:fs');
const {test, expect} = require('@playwright/test');
const {analyzeStatements} = require('../../lib/statements');
const {browserSource} = require('../../lib/browser-source');

const cdn = fs.readFileSync(require.resolve('alpinejs').replace(/module.cjs.js$/, 'cdn.js'), 'utf8');
const memo = 'var evaluatorMemo = {};';
const countedCdn = cdn.replace(memo, memo + '\nwindow.alpineMemoSize = () => Object.keys(evaluatorMemo).length;');
const origin = 'http://mtc-cache.test';
const site = '<!doctype html><script defer src="/alpine.js"></script>' +
    '<main x-data="{title: \'native\'}"><button id="warm" :title="title">Warm</button><div id="mount"></div></main>';

async function open(page, collect) {
    expect(countedCdn).not.toBe(cdn);
    if (collect) await page.addInitScript({content: '(() => {' +
        'const hits = window.templateHits = {};\n' +
        browserSource() + '.observeExecution(window, (template, statement) => {' +
        'const key = template + ":" + statement; hits[key] = (hits[key] || 0) + 1; });' +
        '})()'});
    await page.route(origin + '/**', async route => {
        if (route.request().url() === origin + '/alpine.js') {
            await route.fulfill({contentType: 'application/javascript', body: countedCdn});
        } else await route.fulfill({contentType: 'text/html', body: site});
    });
    await page.goto(origin + '/');
    await expect(page.locator('#warm')).toHaveAttribute('title', 'native');
}

for (const collect of [true, false]) {
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
