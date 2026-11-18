import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createActionLock, createLatestRequestGate } from "../src/utils/asyncState.js";

const source = await readFile(
  new URL("../src/views/AccountDetailView.vue", import.meta.url),
  "utf8",
);
const ref = (value) => ({ value });

function bindFunctions(names, bindings) {
  const declarations = names.map((name) => {
    const start = source.match(new RegExp(`^(?:async )?function ${name}\\(`, "m"))?.index;
    assert.notEqual(start, undefined, `${name} must exist`);
    const end = source.indexOf("\n}", start);
    assert.ok(end > start, `${name} must have a top-level closing brace`);
    return source.slice(start, end + 2);
  });
  return new Function(
    ...Object.keys(bindings),
    `${declarations.join("\n")}\nreturn { ${names.join(", ")} };`,
  )(...Object.values(bindings));
}

function loadHarness(overrides = {}) {
  const state = {
    account: ref(null), aliases: ref([]), currentPage: ref(1), pageSize: ref(20),
    total: ref(0), appliedAliasQuery: ref(""),
    aliasEnabledFilter: ref(""), aliasGroupFilter: ref("12"),
    selectedAliasRecords: ref(new Map()), aliasSelectionActive: ref(false),
    appleSession: ref(null), autoCreation: ref(null), loading: ref(false),
    loadError: ref(null),
  };
  return {
    ...state,
    ...bindFunctions(["detailRequestKey", "loadDetail"], {
      ...state,
      viewActive: true,
      DEFAULT_PAGE_SIZE: 20,
      ALL_PAGE_SIZE: 0,
      detailRouteKey: () => "42",
      detailMutationPending: () => false,
      detailGate: createLatestRequestGate(),
      detailAbortController: null,
      selectableAliases: { get value() { return state.aliases.value; } },
      loadMailGroups: async () => {},
      setPageHeader() {},
      getAccount: async () => ({
        account: { id: 42, aliasCount: 80 },
        aliases: [{ id: 99 }],
        pagination: { total: 80 },
      }),
      getAliasPage: async () => ({ items: [], total: 0 }),
      getAllAliases: async () => [],
      ...overrides,
    }),
  };
}

test("changing groups clears cross-page selections and reloads from page one", () => {
  let reloads = 0;
  let stopped = false;
  const abort = new AbortController();
  const state = {
    currentPage: ref(4), aliases: ref([{ id: 9 }]), total: ref(99),
    loadError: ref(new Error("old request")),
    selectedAliasRecords: ref(new Map([[7, { id: 7 }], [9, { id: 9 }]])),
  };
  const functions = bindFunctions([
    "applyAliasGroupFilter", "resetAliasSearchResults", "clearAliasSelection",
  ], {
    ...state,
    loadDetail: () => { reloads += 1; },
    detailGate: createLatestRequestGate(),
    detailAbortController: abort,
    aliasDrag: { stop() { stopped = true; } },
  });
  functions.applyAliasGroupFilter();
  assert.equal(state.currentPage.value, 1);
  assert.equal(state.total.value, 0);
  assert.equal(state.loadError.value, null);
  assert.deepEqual(state.aliases.value, []);
  assert.equal(state.selectedAliasRecords.value.size, 0);
  assert.equal(abort.signal.aborted, true);
  assert.equal(stopped, true);
  assert.equal(reloads, 1);
});

test("clearing search resets the group, status and keyword together", () => {
  const state = {
    aliasQueryDraft: ref("draft"), appliedAliasQuery: ref("applied"),
    aliasEnabledFilter: ref("false"), aliasGroupFilter: ref("none"),
  };
  let resets = 0;
  const { clearAliasSearch } = bindFunctions(["clearAliasSearch"], {
    ...state,
    hasAliasSearch: ref(true),
    resetAliasSearchResults: () => { resets += 1; },
  });
  clearAliasSearch();
  for (const filter of Object.values(state)) assert.equal(filter.value, "");
  assert.equal(resets, 1);
});

test("group-only paging uses the filtered total and preserves the account count", async () => {
  for (const groupId of ["12", "none"]) {
    const calls = [];
    const items = [{ id: 3, accountId: 42, groupId: groupId === "none" ? null : 12 }];
    const page = loadHarness({
      getAliasPage: async (id, options) => {
        calls.push({ id, ...options });
        return { items, total: 35 };
      },
    });
    page.aliasGroupFilter.value = groupId;
    page.currentPage.value = 2;
    assert.equal(await page.loadDetail(), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, "42");
    assert.equal(calls[0].groupId, groupId);
    assert.equal(calls[0].limit, 20);
    assert.equal(calls[0].offset, 20);
    assert.deepEqual(page.aliases.value, items);
    assert.equal(page.total.value, 35);
    assert.equal(page.account.value.aliasCount, 80);
  }
});

test("all-items mode forwards the group with keyword and status filters", async () => {
  for (const groupId of ["12", "none"]) {
    let received;
    const page = loadHarness({
      getAllAliases: async (id, options) => {
        received = { id, ...options };
        return [{ id: 3 }, { id: 4 }];
      },
    });
    page.aliasGroupFilter.value = groupId;
    page.pageSize.value = 0;
    page.appliedAliasQuery.value = "team";
    page.aliasEnabledFilter.value = "false";
    assert.equal(await page.loadDetail(), true);
    assert.equal(received.id, "42");
    assert.equal(received.groupId, groupId);
    assert.equal(received.query, "team");
    assert.equal(received.enabled, false);
    assert.equal(page.total.value, 2);
    assert.equal(page.account.value.aliasCount, 80);
  }
});

test("a delayed old-group response cannot replace the new group results", async () => {
  let resolveOld;
  const oldResponse = new Promise((resolve) => { resolveOld = resolve; });
  const page = loadHarness({
    getAliasPage: async (_id, options) => options.groupId === "12"
      ? oldResponse
      : { items: [{ id: 8, groupId: null }], total: 1 },
  });
  const oldKey = page.detailRequestKey();
  const oldLoad = page.loadDetail();
  page.aliasGroupFilter.value = "none";
  assert.notEqual(page.detailRequestKey(), oldKey);
  assert.equal(await page.loadDetail(), true);
  resolveOld({ items: [{ id: 3, groupId: 12 }], total: 50 });
  assert.equal(await oldLoad, false);
  assert.deepEqual(page.aliases.value, [{ id: 8, groupId: null }]);
  assert.equal(page.total.value, 1);
  assert.equal(page.loading.value, false);
});

test("moving a selected alias out of its group deselects it and refreshes the page", async () => {
  for (const [filter, destination] of [["12", null], ["none", 12]]) {
    const alias = { id: 3, groupId: filter === "none" ? null : 12 };
    const selectedAliasRecords = ref(new Map([[3, alias], [4, { id: 4 }]]));
    const aliasActionLock = createActionLock();
    const groupMoveLoading = {};
    let reloads = 0;
    const { moveAliasToGroup } = bindFunctions([
      "moveAliasToGroup", "matchesAliasGroupFilter",
    ], {
      selectedAliasRecords, aliasActionLock, groupMoveLoading,
      aliasGroupFilter: ref(filter), account: ref({ id: 42 }),
      beginDetailMutation() {},
      moveAliasToGroupRequest: async () => ({ ...alias, groupId: destination }),
      auth: { state: { csrfToken: "csrf" } },
      isCurrentAccount: () => true,
      replaceAlias() {},
      loadDetail: async () => { reloads += 1; },
      loadMailGroups: async () => {},
      successMessage() {},
      showRequestError(error) { throw error; },
    });
    await moveAliasToGroup(alias, destination);
    assert.deepEqual([...selectedAliasRecords.value.keys()], [4]);
    assert.equal(reloads, 1);
    assert.equal(aliasActionLock.hasAny(), false);
    assert.deepEqual(groupMoveLoading, {});
  }
});
