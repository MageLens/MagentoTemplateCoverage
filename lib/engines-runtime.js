// SPDX-FileCopyrightText: MageLens
// SPDX-License-Identifier: MIT
// License: see LICENSE in the repository root.

'use strict';

// Kept separate from Node-only parsers so Cypress does not bundle Acorn/HTML parsers.
module.exports = {
    helper: '__mtcTemplateHit',
    alpineBindingMarker: 'data-mtc-binding-',
    alpinePropertyPath: /^[$A-Z_a-z][$\w]*(?:\.[$A-Z_a-z][$\w]*)*$/
};
