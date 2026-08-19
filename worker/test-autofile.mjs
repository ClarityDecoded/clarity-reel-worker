// Unit tests for the auto-file rules. No network, no DB, no keys:
//   node test-autofile.mjs
//
// The rules are cheap to get subtly wrong (a slug that does not exist in the
// taxonomy, a workspace name that never matches) and both failure modes are
// SILENT in production — the reel just quietly does not get filed. So the
// matching logic is pinned here.
import { autoFile, AUTO_FILE, _resetWorkspaceCache } from './autofile.mjs';
import { CATEGORY_KEYS } from './prompts.mjs';

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
};

/** Minimal stub of the supabase client surface autoFile actually touches. */
function fakeDb({ workspaces = [], failStage = false } = {}) {
  const calls = { updates: [], events: [], tags: [] };
  const client = {
    from(table) {
      if (table === 'workspaces') {
        const q = {
          select: () => q,
          order: () => Promise.resolve({ data: workspaces, error: null }),
        };
        return q;
      }
      if (table === 'reel_results') {
        return {
          update(patch) {
            return {
              eq(_c, id) {
                calls.updates.push({ id, patch });
                return Promise.resolve({ error: failStage ? { message: 'boom' } : null });
              },
            };
          },
        };
      }
      if (table === 'reel_events') {
        return {
          insert(row) { calls.events.push(row); return Promise.resolve({ error: null }); },
        };
      }
      if (table === 'reel_board_tags') {
        return {
          upsert(row) { calls.tags.push(row); return Promise.resolve({ error: null }); },
        };
      }
      throw new Error('unexpected table ' + table);
    },
  };
  return { client, calls };
}

const WS = [
  { id: 'ws-rahul', name: 'Rahul Panchal', created_at: '2026-01-01' },
  { id: 'ws-rel', name: 'Relationships', created_at: '2026-01-02' },
  { id: 'ws-acme', name: 'Acme Co', created_at: '2026-01-03' },
];

console.log('rules reference real categories');
for (const slug of Object.keys(AUTO_FILE)) {
  ok(`"${slug}" is a real category slug`, CATEGORY_KEYS.includes(slug));
}

console.log('\nfitness -> trying + Rahul Panchal');
{
  _resetWorkspaceCache();
  const { client, calls } = fakeDb({ workspaces: WS });
  const notes = await autoFile(client, { id: 'r1', category: 'fitness' });
  ok('stage set to trying', calls.updates[0]?.patch.stage === 'trying');
  ok('stage_at stamped', !!calls.updates[0]?.patch.stage_at);
  ok('event logged', calls.events[0]?.kind === 'trying');
  ok('tagged to the right workspace', calls.tags[0]?.workspace_id === 'ws-rahul');
  ok('reports what it did', notes.length === 2);
}

console.log('\nrelationships -> "Relationship" matches "Relationships"');
{
  _resetWorkspaceCache();
  const { client, calls } = fakeDb({ workspaces: WS });
  await autoFile(client, { id: 'r2', category: 'relationships' });
  ok('contains-match found the workspace', calls.tags[0]?.workspace_id === 'ws-rel');
}

console.log('\nnon-matching categories are left alone');
for (const slug of ['branding', 'recipe', 'stocks', null]) {
  _resetWorkspaceCache();
  const { client, calls } = fakeDb({ workspaces: WS });
  const notes = await autoFile(client, { id: 'r3', category: slug });
  ok(`${slug ?? 'null'} untouched`, notes.length === 0 && !calls.updates.length && !calls.tags.length);
}

console.log('\nfailure modes never throw');
{
  _resetWorkspaceCache();
  const { client, calls } = fakeDb({ workspaces: [], failStage: false });
  const notes = await autoFile(client, { id: 'r4', category: 'fitness' });
  ok('missing workspace -> stage still set, no tag', notes.includes('stage=trying') && !calls.tags.length);
}
{
  _resetWorkspaceCache();
  const { client, calls } = fakeDb({ workspaces: WS, failStage: true });
  const notes = await autoFile(client, { id: 'r5', category: 'fitness' });
  ok('stage write failure -> no event logged', !calls.events.length);
  ok('stage write failure -> tag still applied', calls.tags[0]?.workspace_id === 'ws-rahul');
  ok('stage failure not reported as done', !notes.includes('stage=trying'));
}

console.log(`\n${fail ? `${fail} FAILED, ` : ''}${pass} passed`);
process.exit(fail ? 1 : 0);
