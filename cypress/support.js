// SPDX-FileCopyrightText: MageLens
// SPDX-License-Identifier: MIT
// License: see LICENSE in the repository root.

'use strict';

const { observeTemplates } = require('../lib/browser');
const { observeExecution } = require('../lib/execution');

// `metadata` is called once per test attempt in afterEach; its fields are added to the record,
// for example to identify the attempt. The record's own fields cannot be replaced.
function registerTemplateCoverage({ outputDir = '.template-coverage', metadata } = {}) {
    if (metadata !== undefined && typeof metadata !== 'function') throw new TypeError('metadata must be a function');
    let collector;
    let execution;
    let ids = new Set();
    let hits = {};
    let references = new Map();

    function connect(win) {
        collector?.disconnect();
        execution?.disconnect();
        collector = observeTemplates(win, id => ids.add(id), reference => references.set(JSON.stringify(reference), reference));
        execution = observeExecution(win, (id, statement) => {
            const counters = hits[id] ||= {};
            counters[statement] = (counters[statement] || 0) + 1;
        });
    }

    Cypress.on('test:before:run', () => {
        if (collector) collector.disconnect();
        execution?.disconnect();
        collector = undefined;
        ids = new Set();
        hits = {};
        references = new Map();
    });
    Cypress.on('window:before:load', win => {
        connect(win);
    });
    Cypress.on('window:before:unload', () => {
        if (collector) collector.flush();
    });

    beforeEach(() => {
        // Also supports tests that keep the current page with testIsolation: false.
        cy.window({ log: false }).then(win => {
            if (!collector) connect(win);
        });
    });

    afterEach(function () {
        // Queue this after existing test commands; retain IDs from previous pages.
        cy.then({ log: false }, () => {
            if (collector) collector.flush();
            const recordId = globalThis.crypto.randomUUID?.() ||
                `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
            const extra = metadata ? metadata() : {};
            if (extra === null || typeof extra !== 'object' || Array.isArray(extra)) throw new TypeError('metadata must return an object');
            const record = {
                ...extra,
                schemaVersion: 2,
                recordId,
                spec: Cypress.spec.relative,
                test: Cypress.currentTest.titlePath,
                retry: this.currentTest.currentRetry(),
                ids: [...ids].sort(),
                hits,
                references: [...references.values()]
            };
            return cy.writeFile(`${outputDir}/${recordId}.mtc`, JSON.stringify(record), { log: false });
        });
    });
}

module.exports = { registerTemplateCoverage };
