// SPDX-FileCopyrightText: MageLens
// SPDX-License-Identifier: MIT
// License: see LICENSE in the repository root.

'use strict';
const {test: base, expect} = require('@playwright/test');
const {execFileSync} = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {createManifest, instrument} = require('../../lib');
const {browserSource} = require('../../lib/browser-source');
const fixture = require('../csp-fixture');

const source = `<?php declare(strict_types=1); $mode = $argv[1] ?? ''; ?>
<button id="probe" <?php if ($mode !== 'off'): ?>x-on:click="increment<?= $mode === 'alternate' ? 'Alternate' : '' ?>"<?php endif; ?>>Increment</button>`;
const shell = body => `<!doctype html>
<script defer src="/alpine-csp.js"></script><script src="/morphdom.js"></script>
<section x-data="probeState">${body}<output x-text="count" id="count"></output></section>
<script nonce="mtc-fixture">
document.addEventListener('alpine:init', () => {
    Alpine.data('probeState', () => ({
        count: 0,
        increment() { this.count++; },
        incrementAlternate() { this.count++; }
    }));
});
</script>`;

const test = base.extend({
    site: async ({}, use) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mtc-csp-morph-'));
        const original = path.join(root, 'source'), copy = path.join(root, 'copy');
        fs.mkdirSync(path.join(original, 'app/code'), {recursive: true});
        for (const template of ['a', 'b']) fs.writeFileSync(path.join(original, 'app/code', template + '.phtml'), source);
        const manifest = createManifest({source: original, roots: ['app/code']});
        instrument({source: original, manifest, mappings: {'app/code': copy}});
        const server = http.createServer((request, response) => {
            const url = new URL(request.url, 'http://localhost');
            if (!/^\/[ab]\.html$/.test(url.pathname)) {
                if (!fixture.serve(request, response, copy)) response.writeHead(404).end();
                return;
            }
            const file = path.join(copy, path.basename(url.pathname, '.html') + '.phtml');
            const body = execFileSync('php', ['-n', file, url.searchParams.get('mode') ?? ''], {encoding: 'utf8'});
            response.setHeader('Content-Security-Policy', fixture.policy);
            response.setHeader('Content-Type', 'text/html');
            response.end(shell(body));
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        try { await use({manifest, url: `http://127.0.0.1:${server.address().port}`}); }
        finally {
            await new Promise(resolve => server.close(resolve));
            fs.rmSync(root, {recursive: true, force: true});
        }
    }
});

async function open(page, site, collect = true) {
    if (collect) await page.addInitScript({content: `(() => {
        const hits = window.templateHits = {};
        ${browserSource()}.observeExecution(window, (template, statement) => {
            const key = template + ':' + statement;
            hits[key] = (hits[key] || 0) + 1;
        });
    })()`});
    const response = await page.goto(site.url + '/a.html');
    expect(response.headers()['content-security-policy']).toBe(fixture.policy);
    const html = await response.text();
    expect(html).toMatch(/<button[^>]*x-mtc="[^"]+"[^>]*x-on:click="increment"/);
    await expect(page.locator('#count')).toHaveText('0');
    return html;
}

async function morph(button, ...responses) {
    await button.evaluate((element, html) => {
        for (const response of html) {
            const target = new DOMParser().parseFromString(response, 'text/html').querySelector('#probe');
            if (window.morphdom(element, target) !== element) throw new Error('Morph replaced the button');
        }
    }, responses);
}

async function hits(page, site, file) {
    const entry = site.manifest.templates.find(template => template.path.endsWith('/' + file + '.phtml'));
    const click = entry.statements.find(statement => statement.binding === 'x-on:click');
    return page.evaluate(key => window.templateHits[key] ?? 0, `${entry.id}:${click.id}`);
}

for (const collect of [true, false]) {
    test(`morphdom mutation batch leaves one Alpine CSP listener ${collect ? 'with' : 'without'} collection`, async ({page, site}) => {
        const original = await open(page, site, collect);
        const alternate = await (await page.request.get(site.url + '/a.html?mode=alternate')).text();
        const button = page.locator('#probe');
        await morph(button, original, alternate);
        await expect(button).toHaveAttribute('x-on:click', 'incrementAlternate');
        await button.click();
        await expect(page.locator('#count')).toHaveText('1', {timeout: 2000});
        if (collect) expect(await hits(page, site, 'a')).toBeGreaterThan(0);
    });
}

test('morphdom restores a conditional Alpine CSP directive and its exact coverage', async ({page, site}) => {
    const original = await open(page, site);
    const off = await (await page.request.get(site.url + '/a.html?mode=off')).text();
    const button = page.locator('#probe');
    await morph(button, off);
    await expect(button).not.toHaveAttribute('x-on:click');
    await morph(button, original);
    expect(await hits(page, site, 'a')).toBe(0);
    await button.click();
    await expect(page.locator('#count')).toHaveText('1');
    expect(await hits(page, site, 'a')).toBeGreaterThan(0);
});

test('morphdom marker-only replacement credits the current Alpine CSP template', async ({page, site}) => {
    const original = await open(page, site);
    const replacement = await (await page.request.get(site.url + '/b.html')).text();
    const button = page.locator('#probe');
    await morph(button, original);
    await expect(button).toHaveAttribute('x-on:click', 'increment');
    await morph(button, replacement);
    expect(await hits(page, site, 'a')).toBe(0);
    expect(await hits(page, site, 'b')).toBe(0);
    await button.click();
    await expect(page.locator('#count')).toHaveText('1');
    const credit = {a: await hits(page, site, 'a'), b: await hits(page, site, 'b')};
    expect(credit).toEqual({a: 0, b: expect.any(Number)});
    expect(credit.b).toBeGreaterThan(0);
});
