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

const source = `<?php declare(strict_types=1); $mode = $argv[1] ?? ''; $event = $argv[2] ?? '1'; ?>
<section id="component" x-data="probeState">
    <button id="probe" data-boot <?php if ($mode !== 'off'): ?>x-on:click="increment<?= $mode === 'alternate' ? 'Alternate' : ($mode === 'intermediate' ? 'Intermediate' : '') ?>"<?php endif; ?>>Increment</button>
    <button id="once" x-on:click.once="increment">Increment once</button>
    <button id="aliases" @click="increment" x-on:click="incrementAlternate">Both click directives</button>
    <button x-on:evt-<?= (int)$event ?>="increment" id="event">Generated event</button>
    <output id="count" x-text="count"></output><output id="handled" x-text="handled"></output>
    <template id="list" x-for="item in rows<?= $mode === 'rows' ? 'Next' : '' ?>" :key="item.id">
        <span class="row" x-text="item.label"></span>
    </template>
    <div id="details" x-show="visible" :title="title">Details</div>
    <div id="extract" x-data="extractTitle" x-bind:title="title"></div>
</section>`;
const shell = body => `<!doctype html>
<script defer src="/alpine-csp.js"></script><script src="/morphdom.js"></script>
${body}
<script nonce="mtc-fixture">
document.addEventListener('alpine:init', () => {
    Alpine.data('extractTitle', function () {
        return {initial: Alpine.extractProp(this.$el, 'title')};
    });
    Alpine.data('probeState', () => ({
        count: 0,
        handled: 'none',
        rows: [{id: 1, label: 'initial'}],
        rowsNext: [{id: 2, label: 'two'}, {id: 3, label: 'three'}],
        get visible() { return this.count > 0; },
        get title() { return 'count ' + this.count; },
        get alternateTitle() { return 'alternate ' + this.count; },
        increment() { this.count++; this.handled = 'original'; },
        incrementAlternate() { this.count++; this.handled = 'alternate'; },
        incrementIntermediate() { this.count++; this.handled = 'intermediate'; }
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
            const directory = url.searchParams.has('plain') ? path.join(original, 'app/code') : copy;
            const file = path.join(directory, path.basename(url.pathname, '.html') + '.phtml');
            const args = ['-n', file, url.searchParams.get('mode') ?? '', url.searchParams.get('event') ?? '1'];
            const body = execFileSync('php', args, {encoding: 'utf8'});
            response.setHeader('Content-Security-Policy', fixture.policy);
            response.setHeader('Content-Type', 'text/html');
            response.end(shell(body));
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        try { await use({manifest, url: `http://127.0.0.1:${server.address().port}`}); }
        finally {
            await new Promise(resolve => {
                server.close(resolve);
                server.closeAllConnections();
            });
            fs.rmSync(root, {recursive: true, force: true});
        }
    }
});

async function open(page, site, collect = true, plain = false) {
    if (collect) await page.addInitScript({content: `(() => {
        const hits = window.templateHits = {};
        ${browserSource()}.observeExecution(window, (template, statement) => {
            const key = template + ':' + statement;
            hits[key] = (hits[key] || 0) + 1;
        });
    })()`});
    const response = await page.goto(site.url + '/a.html' + (plain ? '?plain' : ''));
    expect(response.headers()['content-security-policy']).toBe(fixture.policy);
    const html = await response.text();
    if (!plain) expect(html).toMatch(/<button[^>]*x-mtc="[^"]+"[^>]*x-on:click="increment"/);
    await expect(page.locator('#count')).toHaveText('0');
    return html;
}

async function morph(button, ...responses) {
    await button.evaluate((element, html) => {
        for (const response of html) {
            const target = new DOMParser().parseFromString(response, 'text/html').getElementById(element.id);
            if (window.morphdom(element, target) !== element) throw new Error('Morph replaced the element');
        }
    }, responses);
}

async function hits(page, site, file, binding = 'x-on:click') {
    const entry = site.manifest.templates.find(template => template.path.endsWith('/' + file + '.phtml'));
    const click = entry.statements.find(statement => statement.binding === binding);
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
        await expect(page.locator('#handled')).toHaveText('alternate');
        if (collect) expect(await hits(page, site, 'a')).toBeGreaterThan(0);
    });
}

test('multiple changed records bind only the final tracked handler', async ({page, site}) => {
    await open(page, site);
    const intermediate = await (await page.request.get(site.url + '/a.html?mode=intermediate')).text();
    const alternate = await (await page.request.get(site.url + '/a.html?mode=alternate')).text();
    const button = page.locator('#probe');
    await morph(button, intermediate, alternate);
    await button.click();
    await expect(page.locator('#count')).toHaveText('1', {timeout: 2000});
    await expect(page.locator('#handled')).toHaveText('alternate');
    expect(await hits(page, site, 'a')).toBeGreaterThan(0);
});

test('morphdom restores a conditional Alpine CSP directive and its exact coverage', async ({page, site}) => {
    const original = await open(page, site);
    const off = await (await page.request.get(site.url + '/a.html?mode=off')).text();
    const button = page.locator('#probe');
    await morph(button, off);
    await expect(button).not.toHaveAttribute('x-on:click');
    await button.click();
    await expect(page.locator('#count')).toHaveText('0');
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

for (const collect of [true, false]) {
    test(`identical morph preserves Alpine state ${collect ? 'with' : 'without'} coverage`, async ({page, site}) => {
        const original = await open(page, site, collect);
        await page.locator('#probe').click();
        await expect(page.locator('#count')).toHaveText('1');
        await morph(page.locator('#component'), original);
        expect(await page.locator('#component').evaluate(element => Alpine.$data(element).count)).toBe(1);
        await page.locator('#probe').click();
        await expect(page.locator('#count')).toHaveText('2');
        await expect(page.locator('#component')).toHaveAttribute('x-data', 'probeState');
    });

    test(`identical morph preserves a consumed .once listener ${collect ? 'with' : 'without'} coverage`, async ({page, site}) => {
        const original = await open(page, site, collect);
        const button = page.locator('#once');
        await button.click();
        await expect(page.locator('#count')).toHaveText('1');
        const before = collect ? await hits(page, site, 'a', 'x-on:click.once') : 0;
        if (collect) expect(before).toBeGreaterThan(0);
        await morph(button, original);
        await button.click();
        await expect(page.locator('#count')).toHaveText('1');
        if (collect) expect(await hits(page, site, 'a', 'x-on:click.once')).toBe(before);
    });

    test(`unmarked final handler runs once ${collect ? 'with' : 'without'} coverage`, async ({page, site}) => {
        await open(page, site, collect);
        const plain = await (await page.request.get(site.url + '/a.html?plain')).text();
        const alternate = await (await page.request.get(site.url + '/a.html?plain&mode=alternate')).text();
        const button = page.locator('#probe');
        await morph(button, plain, alternate);
        await expect(button).not.toHaveAttribute('x-mtc');
        await button.click();
        await expect(page.locator('#count')).toHaveText('1', {timeout: 2000});
        await expect(page.locator('#handled')).toHaveText('alternate');
        if (collect) expect(await hits(page, site, 'a')).toBe(0);
    });
}

for (const file of ['a', 'b']) {
    test(`generated event follows its rendered name in template ${file.toUpperCase()}`, async ({page, site}) => {
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await open(page, site);
        const replacement = await (await page.request.get(site.url + `/${file}.html?event=2`)).text();
        const button = page.locator('#event');
        await morph(button, replacement);
        await button.dispatchEvent('evt-1');
        await expect(page.locator('#count')).toHaveText('0');
        expect(errors).toEqual([]);
        await button.dispatchEvent('evt-2');
        await expect(page.locator('#count')).toHaveText('1', {timeout: 2000});
        expect(errors).toEqual([]);
        const binding = 'x-on:evt-<?= (int)$event ?>';
        if (file === 'b') expect(await hits(page, site, 'a', binding)).toBe(0);
        expect(await hits(page, site, file, binding)).toBeGreaterThan(0);
    });
}

test('introducing the first marker attributes an existing Alpine listener', async ({page, site}) => {
    await open(page, site, true, true);
    const replacement = await (await page.request.get(site.url + '/a.html')).text();
    const button = page.locator('#probe');
    await morph(button, replacement);
    await expect(button).toHaveAttribute('x-on:click', 'increment');
    expect(await hits(page, site, 'a')).toBe(0);
    await button.click();
    await expect(page.locator('#count')).toHaveText('1');
    expect(await hits(page, site, 'a')).toBeGreaterThan(0);
});

test('introducing a marker does not re-arm an untracked .once listener', async ({page, site}) => {
    await open(page, site, true, true);
    const replacement = await (await page.request.get(site.url + '/a.html')).text();
    const button = page.locator('#once');
    await button.click();
    await expect(page.locator('#count')).toHaveText('1');
    await morph(button, replacement);
    await expect(button).toHaveAttribute('x-mtc', /:/);
    await button.click();
    await expect(page.locator('#count')).toHaveText('1');
    expect(await hits(page, site, 'a', 'x-on:click.once')).toBe(0);
});

for (const collect of [true, false]) {
    test(`first marker preserves listener order ${collect ? 'with' : 'without'} coverage`, async ({page, site}) => {
        await open(page, site, collect, true);
        const button = page.locator('#probe');
        expect(await button.evaluate(element => {
            const undo = Alpine.addScopeToNode(element.parentElement, {scopeProbe: true});
            try { return Alpine.$data(element).scopeProbe; }
            finally { undo(); }
        })).toBe(true);
        await button.evaluate(element => {
            element.addEventListener('click', event => event.stopImmediatePropagation());
        });
        await morph(button, await (await page.request.get(site.url + '/a.html')).text());
        await button.click();
        await expect(page.locator('#count')).toHaveText('1', {timeout: 2000});
        if (collect) expect(await hits(page, site, 'a')).toBeGreaterThan(0);
    });

    test(`first marker preserves both click aliases ${collect ? 'with' : 'without'} coverage`, async ({page, site}) => {
        await open(page, site, collect, true);
        const button = page.locator('#aliases');
        await morph(button, await (await page.request.get(site.url + '/a.html')).text());
        await button.click();
        await expect(page.locator('#count')).toHaveText('2', {timeout: 2000});
        await expect(page.locator('#handled')).toHaveText('alternate');
        if (collect) {
            const entry = site.manifest.templates.find(template => template.path.endsWith('/a.phtml'));
            const clickIds = entry.statements.filter(statement =>
                entry.source.split('\n')[statement.start.line - 1].includes('id="aliases"')).map(statement => statement.id);
            expect(clickIds).toHaveLength(2);
            for (const id of clickIds) {
                expect(await page.evaluate(key => window.templateHits[key] ?? 0, `${entry.id}:${id}`)).toBeGreaterThan(0);
            }
        }
    });
}

test('removing an unrelated attribute before binding retains click coverage', async ({page, site}) => {
    await page.addInitScript(() => {
        document.addEventListener('alpine:init', () => Alpine.interceptInit(element => {
            if (element.id === 'probe') element.removeAttribute('data-boot');
        }));
    });
    await open(page, site);
    const button = page.locator('#probe');
    await expect(button).not.toHaveAttribute('data-boot');
    await button.click();
    await expect(page.locator('#count')).toHaveText('1');
    expect(await hits(page, site, 'a')).toBeGreaterThan(0);
});

test('an active .once listener and reactive text collect after their first markers', async ({page, site}) => {
    await open(page, site, true, true);
    const replacement = await (await page.request.get(site.url + '/a.html')).text();
    const button = page.locator('#once');
    const count = page.locator('#count');
    await morph(button, replacement);
    await morph(count, replacement);
    expect(await hits(page, site, 'a', 'x-on:click.once')).toBe(0);
    expect(await hits(page, site, 'a', 'x-text')).toBe(0);
    await button.click();
    await expect(count).toHaveText('1');
    const onceHits = await hits(page, site, 'a', 'x-on:click.once');
    expect(onceHits).toBeGreaterThan(0);
    expect(await hits(page, site, 'a', 'x-text')).toBeGreaterThan(0);
    await button.click();
    await expect(count).toHaveText('1');
    expect(await hits(page, site, 'a', 'x-on:click.once')).toBe(onceHits);
});

for (const collect of [true, false]) {
    test(`stored keyed list expressions survive ${collect ? 'with' : 'without'} coverage`, async ({page, site}) => {
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await open(page, site, collect);
        await expect(page.locator('.row')).toHaveText(['initial']);
        const before = collect ? await hits(page, site, 'a', ':key') : 0;
        if (collect) expect(before).toBeGreaterThan(0);
        const list = page.locator('#list');
        const replacement = await (await page.request.get(site.url + '/a.html?plain&mode=rows')).text();
        await morph(list, replacement);
        await expect(list).toHaveAttribute(':key', 'item.id');
        await expect(page.locator('.row')).toHaveText(['two', 'three'], {timeout: 2000});
        if (collect) expect(await hits(page, site, 'a', ':key')).toBe(before);
        expect(errors).toEqual([]);
    });

    test(`extractProp can read a stored expression later ${collect ? 'with' : 'without'} coverage`, async ({page, site}) => {
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await open(page, site, collect);
        await page.locator('#probe').click();
        const prop = await page.locator('#extract').evaluate(element => Alpine.extractProp(element, 'title'));
        expect(prop).toBe('count 1');
        expect(errors).toEqual([]);
    });
}

test('marker-only morph credits the current template before Alpine sees mutations', async ({page, site}) => {
    await open(page, site);
    const target = await (await page.request.get(site.url + '/b.html')).text();
    const clickKeys = site.manifest.templates.map(entry => {
        const click = entry.statements.find(statement => statement.binding === 'x-on:click');
        return `${entry.id}:${click.id}`;
    });
    const inTask = await page.locator('#probe').evaluate((element, {target, clickKeys}) => {
        const incoming = new DOMParser().parseFromString(target, 'text/html').getElementById(element.id);
        if (window.morphdom(element, incoming) !== element) throw new Error('Morph replaced the button');
        element.click();
        return clickKeys.map(key => window.templateHits[key] ?? 0);
    }, {target, clickKeys});
    await expect(page.locator('#count')).toHaveText('1');
    expect(inTask[0]).toBe(0);
    expect(inTask[1]).toBeGreaterThan(0);
    expect(await hits(page, site, 'a')).toBe(0);
    expect(await hits(page, site, 'b')).toBe(inTask[1]);
});

test('reactive show and bind collect subsequent evaluations after their first markers', async ({page, site}) => {
    await open(page, site, true, true);
    const details = page.locator('#details');
    await expect(details).toBeHidden();
    await expect(details).toHaveAttribute('title', 'count 0');
    const replacement = await (await page.request.get(site.url + '/a.html')).text();
    await morph(details, replacement);
    expect(await hits(page, site, 'a', 'x-show')).toBe(0);
    expect(await hits(page, site, 'a', ':title')).toBe(0);
    await page.locator('#probe').click();
    await expect(details).toBeVisible();
    await expect(details).toHaveAttribute('title', 'count 1');
    expect(await hits(page, site, 'a', 'x-show')).toBeGreaterThan(0);
    expect(await hits(page, site, 'a', ':title')).toBeGreaterThan(0);
});

test('retained elements keep bounded cleanup state through repeated rebinds', async ({page, site}) => {
    await open(page, site);
    expect(await page.locator('#details').evaluate(element => {
        const undo = Alpine.addScopeToNode(element.parentElement, {scopeProbe: true});
        try { return Alpine.$data(element).scopeProbe; }
        finally { undo(); }
    })).toBe(true);
    const counts = await page.evaluate(async () => {
        const button = document.getElementById('probe');
        const details = document.getElementById('details');
        for (let i = 0; i < 50; i++) {
            button.setAttribute('x-on:click', i % 2 ? 'increment' : 'incrementAlternate');
            details.setAttribute(':title', i % 2 ? 'title' : 'alternateTitle');
            await new Promise(resolve => queueMicrotask(resolve));
        }
        const cleanups = (element, name) => element._x_attributeCleanups?.[name]?.length ?? 0;
        return {
            click: cleanups(button, 'x-on:click'), bind: cleanups(details, ':title'),
            prepare: cleanups(button, 'x-mtc-prepare'), scope: cleanups(details, 'x-mtc-scope')
        };
    });
    await page.locator('#probe').click();
    await expect(page.locator('#details')).toHaveAttribute('title', 'count 1');
    expect(counts.click).toBeGreaterThan(0);
    expect(counts.bind).toBeGreaterThan(0);
    expect(counts.click).toBeLessThanOrEqual(2);
    expect(counts.bind).toBeLessThanOrEqual(2);
    expect(counts.prepare).toBeLessThanOrEqual(1);
    expect(counts.scope).toBeLessThanOrEqual(1);
});
