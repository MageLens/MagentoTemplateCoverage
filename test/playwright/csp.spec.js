// SPDX-FileCopyrightText: MageLens
// SPDX-License-Identifier: MIT
// License: see LICENSE in the repository root.

'use strict';
const {test: base, expect} = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {createManifest, instrument, readRecords} = require('../../lib');
const {installTemplateRuntime, registerTemplateCoverage} = require('../../playwright');
const fixture = require('../csp-fixture');

const test = base.extend({
    site: async ({}, use) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mtc-csp-'));
        const source = path.join(root, 'source'), copy = path.join(root, 'copy');
        fixture.write(path.join(source, 'app/code'));
        const manifest = createManifest({source, roots: ['app/code']});
        instrument({source, manifest, mappings: {'app/code': copy}});
        const server = http.createServer((req, res) => {if (!fixture.serve(req, res, copy)) res.writeHead(404).end();});
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        try { await use({root, manifest, url: `http://127.0.0.1:${server.address().port}`}); }
        finally {
            await new Promise(resolve => server.close(resolve));
            fs.rmSync(root, {recursive: true, force: true});
        }
    }
});

test('instrumented Alpine CSP works in a browser without the coverage runtime', async ({page, site}) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const file of ['csp-baseline.html', 'csp.html']) {
        const response = await page.goto(`${site.url}/${file}`);
        expect(response.headers()['content-security-policy']).toBe(fixture.policy);
        expect(errors).toEqual([]);
        await expect(page.locator('#initialized')).toHaveText('ready');
        await page.locator('#name').fill('updated');
        await expect(page.locator('#echo')).toHaveText('updated');
        await page.locator('#increment').click();
        await expect(page.locator('#count')).toHaveText('1');
        await expect(page.locator('.item')).toHaveText(['one', 'two']);
        await page.locator('#insert').click();
        await expect(page.locator('#inserted')).toHaveText('updated');
        expect(errors).toEqual([]);
    }
});

for (const collect of [true, false]) {
    test(`Alpine CSP handles a morphed listener ${collect ? 'with' : 'without'} coverage`, async ({context, page, site}) => {
        const hits = path.join(site.root, 'hits');
        const coverage = collect ? await registerTemplateCoverage(context, {outputDir: hits}) : null;
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        try {
            const response = await page.goto(`${site.url}/csp.html`);
            const source = await response.text();
            expect(source).toMatch(/<button[^>]*id="increment"[^>]*x-on:click="increment"/);
            const entry = site.manifest.templates.find(template => template.path.endsWith('/csp.phtml'));
            const click = entry.statements.find(statement => statement.binding === 'x-on:click');
            expect(click).toBeDefined();
            const button = page.locator('#increment');
            const count = page.locator('#count');
            await expect(count).toHaveText('0');
            await page.addScriptTag({url: `${site.url}/morphdom.js`});
            await button.evaluate((element, html) => {
                const original = new DOMParser().parseFromString(html, 'text/html').getElementById('increment');
                if (window.morphdom(element, original) !== element) throw new Error('Expected the existing button to be updated');
            }, source);
            await button.click();
            await expect(count).toHaveText('1');
            expect(errors).toEqual([]);
            if (coverage) {
                await coverage.stop();
                const [record] = readRecords(hits);
                expect(record.hits[entry.id]?.[click.id] ?? 0, 'Coverage of the rebound x-on:click statement').toBeGreaterThan(0);
            }
        } finally {
            await coverage?.stop();
        }
    });
}

test('strict CSP preserves Alpine behavior, scopes and execution coverage', async ({context, page, site}) => {
    const hits = path.join(site.root, 'hits');
    const coverage = await registerTemplateCoverage(context, {outputDir: hits});
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await context.addInitScript(() => {
        window.cspViolations = [];
        document.addEventListener('securitypolicyviolation', event => window.cspViolations.push(event.violatedDirective));
    });
    try {
        for (const file of ['csp-baseline.html', 'csp.html']) {
            const response = await page.goto(`${site.url}/${file}`);
            expect(response.headers()['content-security-policy']).toBe(fixture.policy);
            await expect(page.locator('#initialized')).toHaveText('ready');
            await expect(page.locator('#echo')).toHaveText('initial');
            await page.locator('#name').fill('updated');
            await expect(page.locator('#echo')).toHaveText('updated');
            await page.locator('#increment').click();
            await page.locator('#async').click();
            await expect(page.locator('#count')).toHaveText('2');
            await expect(page.locator('.item')).toHaveText(['one', 'two']);
            await expect(page.locator('#never')).toHaveCount(0);
            await page.locator('#insert').click();
            await expect(page.locator('#inserted')).toHaveText('updated');
            expect(await page.evaluate(() => {
                window.dispatchEvent(new CustomEvent('update-gallery-42', {detail: 'gallery-updated'}));
                window.dispatchEvent(new CustomEvent('update-prices-42', {detail: 'price-updated'}));
                const event = new Event('submit', {bubbles: true, cancelable: true});
                document.querySelector('#prevented').dispatchEvent(event);
                return event.defaultPrevented;
            })).toBe(true);
            await expect(page.locator('#image')).toHaveText('gallery-updated');
            await expect(page.locator('#price')).toHaveText('price-updated');
            expect(await page.evaluate(() => window.cspViolations)).toEqual([]);
        }
        expect(errors).toEqual([]);
        await coverage.stop();
        fixture.verify(site.manifest, readRecords(hits));
        const warmupContext = await context.browser().newContext();
        try {
            await installTemplateRuntime(warmupContext);
            const warmup = await warmupContext.newPage();
            await warmup.goto(`${site.url}/csp.html`);
            await warmup.locator('#increment').click();
            await expect(warmup.locator('#count')).toHaveText('1');
        } finally { await warmupContext.close(); }
    } finally {
        await coverage.stop();
    }
});
