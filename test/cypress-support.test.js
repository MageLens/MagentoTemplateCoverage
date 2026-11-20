// SPDX-FileCopyrightText: MageLens
// SPDX-License-Identifier: MIT
// License: see LICENSE in the repository root.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Runs the Cypress adapter's afterEach with stand-ins for the Cypress globals and returns the written record.
function writtenRecord(options) {
    const hooks = {};
    const writes = [];
    globalThis.Cypress = {on() {}, spec: {relative: 'cypress/e2e/cart.cy.js'}, currentTest: {titlePath: ['cart', 'adds a product']}};
    globalThis.beforeEach = hook => { hooks.beforeEach = hook; };
    globalThis.afterEach = hook => { hooks.afterEach = hook; };
    globalThis.cy = {then: (_options, callback) => callback(), writeFile: (file, contents) => writes.push([file, JSON.parse(contents)])};
    try {
        delete require.cache[require.resolve('../cypress/support')];
        require('../cypress/support').registerTemplateCoverage(options);
        hooks.afterEach.call({currentTest: {currentRetry: () => 1}});
        assert.equal(writes.length, 1);
        assert.match(writes[0][0], /^out\/.+\.mtc$/);
        return writes[0][1];
    } finally {
        for (const name of ['Cypress', 'beforeEach', 'afterEach', 'cy']) delete globalThis[name];
    }
}

test('Cypress records identify the test without metadata', () => {
    const record = writtenRecord({outputDir: 'out'});
    assert.deepEqual({...record, recordId: null}, {schemaVersion: 2, recordId: null, spec: 'cypress/e2e/cart.cy.js',
        test: ['cart', 'adds a product'], retry: 1, ids: [], hits: {}, references: []});
});

test('Cypress metadata adds fields to each record without replacing its own', () => {
    let calls = 0;
    const record = writtenRecord({outputDir: 'out', metadata: () => ({attempt: `attempt-${++calls}`, retry: 7, schemaVersion: 1})});
    assert.equal(calls, 1);
    assert.equal(record.attempt, 'attempt-1');
    assert.equal(record.retry, 1);
    assert.equal(record.schemaVersion, 2);
});

test('Cypress metadata must be a function returning an object', () => {
    assert.throws(() => writtenRecord({outputDir: 'out', metadata: {attempt: 'a'}}), /metadata must be a function/);
    assert.throws(() => writtenRecord({outputDir: 'out', metadata: () => null}), /metadata must return an object/);
});
