// SPDX-FileCopyrightText: MageLens
// SPDX-License-Identifier: MIT
// License: see LICENSE in the repository root.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const Mustache = require('mustache');

const escape = value => String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);
const metric = value => `${value.covered}/${value.total} (${value.percent === null ? 'N/A' : `${value.percent.toFixed(2)}%`})`;
const semantics = 'Executable lines are starting source lines of measured template expressions: Knockout binding value accessors, Underscore expressions/evaluation code, jQuery directives, Magento template literals, Alpine directive evaluations and inline JavaScript statements. Script functions and branch alternatives have separate counters. PHP execution inside PHTML is a separate metric. A binding hit does not prove its event handler ran or its condition was true. Static markup and continuation lines have no execution denominator. DOM presence is measured separately.';
const aggregate = (entries, key) => {
    const total = entries.reduce((sum, entry) => sum + entry[key].total, 0);
    const covered = entries.reduce((sum, entry) => sum + entry[key].covered, 0);
    return { total, covered, uncovered: total - covered, percent: total ? Math.round(covered / total * 10000) / 100 : null };
};
const totals = entries => {
    const eligible = entries.filter(entry => entry.instrumented);
    const covered = eligible.filter(entry => entry.status === 'observed').length;
    return {
        lines: aggregate(entries, 'lineSummary'), statements: aggregate(entries, 'statementSummary'),
        functions: aggregate(entries, 'functionSummary'), branches: aggregate(entries, 'branchSummary'),
        dom: { total: eligible.length, covered, percent: eligible.length ? Math.round(covered / eligible.length * 10000) / 100 : null },
        unsupported: entries.length - eligible.length
    };
};
const directoryFile = directory => directory ? `directories/${createHash('sha256').update(directory).digest('hex').slice(0, 32)}.html` : 'index.html';
const href = (from, to) => path.posix.relative(path.posix.dirname(from), to).split('/').map(encodeURIComponent).join('/');
const optionalRows = rows => rows.length ? { rows } : null;

let templates;
function render(body, view) {
    templates ??= Object.fromEntries(['page', 'summary', 'detail', 'heading', 'metrics'].map(name => [
        name, fs.readFileSync(path.join(__dirname, 'report', name + '.mustache'), 'utf8')
    ]));
    return Mustache.render(templates.page, { semantics, ...view }, {
        body: templates[body],
        heading: templates.heading,
        metrics: templates.metrics
    }, { escape });
}

function breadcrumbItems(file, directory, basename) {
    const items = [{ link: href(file, 'index.html'), label: 'All templates', separator: '' }];
    let cumulative = '';
    for (const part of directory.split('/').filter(Boolean)) {
        cumulative = path.posix.join(cumulative, part);
        items.push({ link: href(file, directoryFile(cumulative)), label: part, separator: ' / ' });
    }
    if (basename) items.push({ link: null, label: basename, separator: ' / ' });
    return items;
}

function heading(values, records) {
    return {
        lines: metric(values.lines), statements: metric(values.statements), functions: metric(values.functions),
        branches: metric(values.branches), dom: metric(values.dom), unsupported: values.unsupported, records
    };
}

function metricCells(values) {
    return ['lines', 'statements', 'functions', 'branches', 'dom'].map(key => {
        const value = values[key];
        const level = value.percent === null ? 'neutral' : value.percent < 50 ? 'low' : value.percent < 90 ? 'medium' : 'high';
        return { level, width: value.percent || 0, label: metric(value) };
    });
}

function limitations(entry) {
    const messages = [entry.executionUnsupported, ...(entry.unsupportedDirectives || []), ...(entry.measurementLimitations || [])];
    for (const script of entry.scripts) {
        if (script.status === 'unsupported') messages.push(`Script at line ${script.line}: ${script.reason}`);
        for (const fragment of script.generated || []) {
            if (!['linked', 'empty'].includes(fragment.status)) messages.push(`Line ${fragment.line}: ${fragment.reason}`);
        }
    }
    const notes = messages.filter(Boolean).map((text, index) => ({ text, separator: index ? ' · ' : '' }));
    return notes.length ? { messages: notes } : null;
}

function fileRow(entry, file, fullPath = false) {
    return {
        label: fullPath ? entry.path : path.posix.basename(entry.path),
        link: entry.instrumented ? href(file, `files/${entry.id}.html`) : null,
        details: {
            engines: entry.engines?.join(', ') || entry.kind,
            status: entry.status,
            notes: limitations(entry)
        },
        cells: metricCells({
            lines: entry.lineSummary, statements: entry.statementSummary,
            functions: entry.functionSummary, branches: entry.branchSummary,
            dom: {
                total: entry.instrumented ? 1 : 0,
                covered: entry.status === 'observed' ? 1 : 0,
                percent: !entry.instrumented ? null : entry.status === 'observed' ? 100 : 0
            }
        })
    };
}

function scriptSummary(scripts) {
    const counts = { linked: 0, empty: 0, unresolved: 0, unobserved: 0 };
    for (const fragment of scripts.references || []) {
        if (Object.hasOwn(counts, fragment.status)) counts[fragment.status]++;
    }
    return { instrumented: scripts.instrumented, unsupported: scripts.unsupported.length, ...counts };
}

function sourceRow(entry, text, index) {
    const number = index + 1, line = entry.lineHits[number];
    const state = !line ? 'neutral' : !line.hits ? 'uncovered' : line.covered < line.statements ? 'partial' : 'covered';
    return { number, state, text, hits: line ? `${line.hits}×` : '' };
}

function counterRow(item) {
    return { line: item.start.line, position: `${item.start.line}:${item.start.column + 1}`, hits: item.hits, status: item.hits ? 'covered' : 'uncovered' };
}

function fileDetail(entry, file, records) {
    const statements = [...entry.statements]
        .sort((a, b) => a.start.line - b.start.line || a.start.column - b.start.column)
        .map(item => ({ ...counterRow(item), binding: item.binding, syntax: item.syntax }));
    const scriptCounters = [
        ...entry.functions.map(item => ({ ...counterRow(item), kind: 'Function', label: item.name })),
        ...entry.branches.map(item => ({
            ...counterRow(item), kind: 'Branch alternative', label: item.type + (item.implicit ? ' (implicit alternative)' : '')
        }))
    ];
    const references = entry.scripts.flatMap(script => script.generated || []).map(fragment => ({
        line: fragment.line,
        status: fragment.status,
        reason: fragment.reason,
        targets: (fragment.targets || []).map(target => ({ link: href(file, `files/${target.id}.html`), label: target.path }))
    }));
    return {
        title: entry.path,
        breadcrumbs: breadcrumbItems(file, path.posix.dirname(entry.path), path.posix.basename(entry.path)),
        summaryHeading: heading(totals([entry]), records),
        notes: limitations(entry),
        engines: entry.engines?.join(', ') || 'knockout',
        status: entry.status,
        observations: entry.observations,
        sourceRows: entry.source.split(/\r\n|\r|\n/).map((text, index) => sourceRow(entry, text, index)),
        statements,
        scriptCounters: optionalRows(scriptCounters),
        references: optionalRows(references)
    };
}

function writeReport(report, output) {
    fs.mkdirSync(path.join(output, 'files'), { recursive: true });
    fs.mkdirSync(path.join(output, 'directories'), { recursive: true });
    const directories = new Map([['', []]]);
    for (const entry of report.templates) {
        const parts = entry.path.split('/');
        for (let index = 0; index < parts.length; index++) {
            const directory = parts.slice(0, index).join('/');
            if (!directories.has(directory)) directories.set(directory, []);
            directories.get(directory).push(entry);
        }
    }
    const writePage = (file, template, view) => fs.writeFileSync(path.join(output, file), render(template, view));
    const baseline = !report.records;
    const summaries = [];
    for (const [directory, entries] of [...directories].sort(([a], [b]) => a.localeCompare(b))) {
        const file = directoryFile(directory), values = totals(entries);
        const children = [...directories.keys()].filter(name => name && path.posix.dirname(name) === (directory || '.')).sort();
        const rows = children.map(child => ({
            label: path.posix.basename(child),
            link: href(file, directoryFile(child)),
            isDirectory: true,
            cells: metricCells(totals(directories.get(child)))
        }));
        const localEntries = entries.filter(entry => path.posix.dirname(entry.path) === (directory || '.'));
        writePage(file, 'summary', {
            title: directory || 'Magento template coverage',
            breadcrumbs: breadcrumbItems(file, directory),
            baseline,
            summaryHeading: heading(values, report.records),
            total: { cells: metricCells(values) },
            rows: rows.concat(localEntries.sort((a, b) => a.path.localeCompare(b.path)).map(entry => fileRow(entry, file))),
            directory: {
                allFilesLink: href(file, 'all.html'),
                scriptSummary: directory ? null : scriptSummary(report.scripts),
                roots: report.roots.join(', ')
            }
        });
        summaries.push({ path: directory, report: file, ...values });
    }
    for (const entry of report.templates.filter(entry => entry.instrumented)) {
        const file = `files/${entry.id}.html`;
        writePage(file, 'detail', fileDetail(entry, file, report.records));
    }
    writePage('all.html', 'summary', {
        title: 'All template files',
        breadcrumbs: breadcrumbItems('all.html', ''),
        baseline,
        allFiles: true,
        total: { cells: metricCells(totals(report.templates)) },
        rows: report.templates.map(entry => fileRow(entry, 'all.html', true))
    });
    fs.writeFileSync(path.join(output, 'coverage-summary.json'), `${JSON.stringify({ ...report, directories: summaries }, null, 2)}\n`);
}

module.exports = { writeReport };
