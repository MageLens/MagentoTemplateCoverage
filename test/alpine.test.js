// SPDX-FileCopyrightText: MageLens
// SPDX-License-Identifier: MIT
// License: see LICENSE in the repository root.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createManifest, instrument, merge} = require('../lib');
const {analyzeStatements} = require('../lib/statements');
const {maskPhp} = require('../lib/alpine');
const {execFileSync} = require('node:child_process');
const id = 'a'.repeat(32);

test('PHTML keeps PHP tokens, strict declarations and source line numbers untouched', t => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mtc-phtml-'));
    t.after(() => fs.rmSync(temporary, {recursive:true,force:true}));
    const source = path.join(temporary, 'source');
    fs.mkdirSync(path.join(source, 'app/code'), {recursive:true});
    const content = `<?php declare(strict_types=1);
// Closing delimiters in quoted strings do not end PHP
$value = '?>';
$literal = <<<'END'
<div x-text="fake"></div>
END;
?>
<div x-data="{name: '<?= htmlspecialchars($value) ?>'}">
<input x-model="name">
<span x-text="name"></span>
</div>`;
    fs.writeFileSync(path.join(source, 'app/code/probe.phtml'), content);
    fs.writeFileSync(path.join(source, 'app/code/plain.phtml'), '<?php echo "plain"; ?>');
    const manifest = createManifest({source, roots: ['app/code']});
    assert.equal(manifest.templates.length, 1);
    const entry = manifest.templates[0];
    assert.equal(entry.kind, 'browser-phtml');
    assert.equal(entry.statements.length, 3);
    assert.deepEqual(entry.statements.map(statement => statement.start.line), [8,9,10]);
    const copy = path.join(temporary, 'copy');
    instrument({source, manifest, mappings: {'app/code': copy}});
    const output = fs.readFileSync(path.join(copy, 'probe.phtml'), 'utf8');
    assert.ok(output.startsWith('<?php declare(strict_types=1);'));
    assert.equal(output.split('\n').length, content.split('\n').length);
    const php = source => maskPhp(source).ranges.map(([start,end]) => source.slice(start,end));
    assert.deepEqual(php(output), php(content));
    assert.equal(fs.readFileSync(path.join(source, 'app/code/probe.phtml'), 'utf8'), content);
    assert.equal(merge(manifest, []).statements.covered, 0);
});

test('mixed HTML keeps Knockout bindings and Alpine events in the same statement map', () => {
    const result = analyzeStatements('<span data-bind="text: label"></span><button x-data="{}" @click="clicked = true">Click</button>', id);
    assert.deepEqual(result.statements.map(statement => statement.syntax), ['data-bind', 'alpine:data', 'alpine:on']);
    assert.match(result.content, /\/\*mtc_/);
    assert.match(result.content, /__mtcTemplateHit/);
});

test('dynamic PHP model expressions stay unchanged with an explicit limitation', () => {
    const source = '<input x-model="values[<?= $key ?>]">';
    const result = analyzeStatements(source, id, 'alpine', {phtml:true});
    assert.equal(result.content, source);
    assert.equal(result.statements.length, 0);
    assert.equal(result.unsupported.length, 1);
});


test('standalone Alpine initialization and HTML directives are discovered', () => {
    for (const [attribute, syntax] of [['x-init="initialize()"', 'alpine:init'], ['x-html="content"', 'alpine:html'], ['x-html-safe="content"', 'alpine:html-safe']]) {
        const result = analyzeStatements(`<div ${attribute}></div>`, id);
        assert.equal(result.statements.length, 1);
        assert.equal(result.statements[0].syntax, syntax);
    }
});


test('CSP component paths retain PHP-generated identifier suffixes and original tokens', () => {
    const source = '<section x-data="component<?= (int) $id ?>"><span x-text="name"></span></section>';
    const result = analyzeStatements(source, id, 'alpine', {phtml: true});
    assert.equal((result.unsupported || []).length, 0);
    assert.match(result.content, /x-data="component<\?= \(int\) \$id \?>" data-mtc-binding-0="x-data"/);
    assert.ok(!result.content.includes('__mtcTemplateHit'));
    assert.equal(result.content.split('\n').length, source.split('\n').length);
});

test('PHP event names retain complete names, modifiers, offsets and conditional attributes', () => {
    const source = `<?php declare(strict_types=1); $productId = 42; ?>
<section
<?php if ($productId): ?>@update-prices-<?= (int)$productId ?>.window="updatePrice"<?php endif; ?>
 x-data="component" @update-gallery-<?= (int)$productId ?>.window="updateImage"
 @update-gallery-<?= (int)$productId + 1 ?>.window="unused"
 x-on:update-<?=
 (int)$productId
 ?>.window="updateImage"
><?php echo __LINE__; ?></section>`;
    const result = analyzeStatements(source, id, 'auto', {phtml: true});
    assert.deepEqual(result.unsupported || [], []);
    assert.deepEqual(result.statements.map(s => s.binding), [
        '@update-prices-<?= (int)$productId ?>.window', 'x-data',
        '@update-gallery-<?= (int)$productId ?>.window',
        '@update-gallery-<?= (int)$productId + 1 ?>.window',
        'x-on:update-<?=\n (int)$productId\n ?>.window'
    ]);
    assert.deepEqual(result.statements.map(s => s.start.line), [3, 4, 4, 5, 6]);
    const php = text => maskPhp(text).ranges.map(([start, end]) => text.slice(start, end));
    assert.deepEqual(php(result.content).filter(code => !code.includes('$__mtcAlpineName_')), php(source));
    assert.equal(result.content.split('\n').length, source.split('\n').length);
    for (const productId of [42, 0]) {
        const render = text => execFileSync('php', ['-n'], {input: text.replace('$productId = 42', `$productId = ${productId}`), encoding: 'utf8'});
        const baseline = render(source), instrumented = render(result.content);
        assert.equal(instrumented.includes('@update-prices-'), Boolean(productId));
        assert.match(instrumented, /x-mtc="[^"]+"/);
        assert.match(instrumented, new RegExp(`@update-gallery-${productId}\\.window="updateImage" data-mtc-binding-\\d+="@update-gallery-${productId}\\.window"`));
        assert.equal(instrumented.replace(/ x-mtc="[^"]+"| data-mtc-binding-\d+="[^"]*"/g, ''), baseline);
    }
});

test('a PHP-generated Alpine event name is rendered once and normalized in its marker', () => {
    const source = '<?php $i = 1; ?><div @EVT-<?= $i++ ?>.window\n="add"><?= $i ?></div>';
    const result = analyzeStatements(source, id, 'alpine', {phtml: true});
    const render = text => execFileSync('php', ['-n'], {input: text, encoding: 'utf8'});
    const instrumented = render(result.content);
    assert.match(instrumented, /data-mtc-binding-0="@evt-1\.window"/);
    assert.equal(instrumented.replace(/ x-mtc="[^"]+"| data-mtc-binding-0="[^"]*"/g, ''), render(source));
    assert.equal(result.content.split('\n').length, source.split('\n').length);
});

test('a throwing PHP event name leaves the template renderer buffer balanced', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mtc-php-event-'));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    const source = '<button x-on:evt-<?= $eventName() ?>="add">Add</button>';
    const instrumented = analyzeStatements(source, id, 'alpine', {phtml: true}).content;
    const driver = `
        $before = ob_get_level();
        $failure = new RuntimeException('event name unavailable');
        $eventName = function () use ($failure) { throw $failure; };
        try {
            ob_start();
            try { include $argv[1]; }
            catch (Throwable $error) { ob_end_clean(); throw $error; }
            ob_end_clean();
        } catch (Throwable $error) {
            $after = ob_get_level();
            while (ob_get_level() > $before) ob_end_clean();
            echo json_encode(['delta' => $after - $before, 'sameError' => $error === $failure]);
        }
    `;
    for (const content of [source, instrumented]) {
        const file = path.join(directory, 'button.phtml');
        fs.writeFileSync(file, content);
        const result = JSON.parse(execFileSync('php', ['-n', '-r', driver, file], {encoding: 'utf8'}));
        assert.deepEqual(result, {delta: 0, sameError: true});
    }
});

test('modifier-only listeners have no expression to instrument, while malformed expressions remain visible', () => {
    for (const attribute of ['@submit.prevent', 'x-on:submit.prevent', '@click.stop.once', '@submit.prevent=""']) {
        const source = `<form ${attribute}></form>`;
        const result = analyzeStatements(source, id, 'alpine', {phtml: true});
        assert.equal(result.content, source);
        assert.deepEqual(result.statements, []);
        assert.deepEqual(result.unsupported || [], []);
    }
    for (const attribute of ['@click=handler', '@click="broken("', 'x-text']) {
        const result = analyzeStatements(`<div ${attribute}></div>`, id, 'alpine', {phtml: true});
        assert.equal(result.statements.length, 0);
        assert.equal(result.unsupported.length, 1);
    }
});

test('multiline PHP event names keep subsequent Knockout warnings at original source lines', () => {
    const source = `<div @update-<?=
42
?>.window="handler">
<span data-bind="<?= 'text: name' ?>"></span>
<!-- ko if: <?= $visible ?> -->
<span data-bind="text: name"></span>
<!-- /ko -->
</div>`;
    const result = analyzeStatements(source, id, 'auto', {phtml: true});
    assert.deepEqual(result.unsupported, ['PHP-generated binding at line 4', 'PHP-generated Knockout binding at line 5']);
    assert.deepEqual(result.statements.map(statement => statement.start.line).sort((a, b) => a - b), [1, 6]);
});
