"use strict";

const vm = require("vm");

function sorted(xs) {
  return Array.from(new Set(Array.isArray(xs) ? xs : [])).sort();
}

function extractUiEndpointCatalogFromSource(uiSrc) {
  const sandbox = {
    window: {
      __byokCfgPanel: {
        normalizeStr: (v) => v,
        uniq: (xs) => xs,
        escapeHtml: (v) => v,
        optionHtml: () => "",
        computeProviderIndexById: () => 0
      }
    }
  };
  vm.runInNewContext(String(uiSrc || ""), sandbox, { timeout: 1000 });
  const groups = Array.isArray(sandbox.window?.__byokCfgPanel?.ENDPOINT_GROUPS_V1) ? sandbox.window.__byokCfgPanel.ENDPOINT_GROUPS_V1 : [];
  const endpoints = sorted(Array.from(new Set(groups.flatMap((g) => (Array.isArray(g?.endpoints) ? g.endpoints : [])))));
  const meanings =
    sandbox.window?.__byokCfgPanel?.ENDPOINT_MEANINGS_V1 &&
    typeof sandbox.window.__byokCfgPanel.ENDPOINT_MEANINGS_V1 === "object" &&
    !Array.isArray(sandbox.window.__byokCfgPanel.ENDPOINT_MEANINGS_V1)
      ? sandbox.window.__byokCfgPanel.ENDPOINT_MEANINGS_V1
      : {};
  return { groups, endpoints, meanings };
}

module.exports = { extractUiEndpointCatalogFromSource };
