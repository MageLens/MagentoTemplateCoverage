// SPDX-FileCopyrightText: MageLens
// SPDX-License-Identifier: MIT
// License: see LICENSE in the repository root.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {test: base, expect} = require('@playwright/test');
const {withTemplateCoverage} = require('../../playwright');

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtc-metadata-'));
const test = withTemplateCoverage(base);
test.use({templateCoverageOptions: {outputDir, metadata: {attempt: 'attempt-1', spec: 'replaced', retry: 9}}});
test.afterAll(() => fs.rmSync(outputDir, {recursive: true, force: true}));

test('the fixture writes its record when the context closes', async ({page}) => {
    await page.setContent('<p>Page</p>');
});

test('custom metadata reaches the record through the fixture without replacing the test identity', () => {
    const [file] = fs.readdirSync(outputDir);
    const record = JSON.parse(fs.readFileSync(path.join(outputDir, file), 'utf8'));
    expect(record.attempt).toBe('attempt-1');
    expect(record.spec).toBe(__filename);
    expect(record.retry).toBe(0);
    expect(record.test.at(-1)).toBe('the fixture writes its record when the context closes');
});
