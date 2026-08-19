// Auto-filing: some subjects are always for Rahul, so the worker pre-sorts them
// instead of making him do it by hand on every dump.
//
// A matching reel is (a) put on the lifecycle scale at "Want to try" and (b)
// tagged to a workspace, which surfaces it on that workspace's References tab.
//
// THE ONE THING THAT MATTERS HERE: an auto-flag DOES write a `reel_events` row,
// and that is a deliberate call. The instinct is the opposite — a rule deciding
// for you is not you deciding, and the flagged count is supposed to mean "ideas
// I chose to act on" (gotcha #56). Two things overrule that instinct:
//   1. For these categories the dump IS the decision. Rahul saves a fitness or
//      personal-dev reel BECAUSE he intends to try it; the intent happens at the
//      share sheet, not later at the slider.
//   2. Without the event, the chips and the chart contradict each other — the
//      reel counts under the Trying filter (which reads `stage`) but never
//      appears in the chart's trying bar (which reads the event log). A number
//      that disagrees with the list next to it is worse than either answer.
// If auto-filed reels ever start drowning out the real signal, delete the
// logStage() call below — nothing else depends on it.
//
// Everything here is best effort. Auto-filing is a convenience — it must never
// cost the item, which has already been fully processed by the time we run.

/** category slug -> what to do with it. Slugs must match CATEGORY_KEYS/CATS. */
export const AUTO_FILE = {
  fitness:       { stage: 'trying', workspace: 'Rahul Panchal' },
  growth:        { stage: 'trying', workspace: 'Rahul Panchal' },  // "Personal dev"
  relationships: { stage: 'trying', workspace: 'Relationship' },
};

// Workspaces are looked up BY NAME, not by a hardcoded UUID, so this file stays
// readable and survives a workspace being recreated. Cached per run.
const wsCache = new Map();

// Test hook. A run is one process and workspaces do not change mid-run, so the
// cache is never cleared in production — but tests need each case isolated.
export function _resetWorkspaceCache() { wsCache.clear(); }

async function findWorkspaceId(supabase, name) {
  if (wsCache.has(name)) return wsCache.get(name);

  const { data, error } = await supabase
    .from('workspaces')
    .select('id, name, created_at')
    .order('created_at', { ascending: true });

  let id = null;
  if (error) {
    console.warn('  auto-file: could not read workspaces —', error.message);
  } else {
    const rows = data || [];
    const want = name.trim().toLowerCase();
    // Exact name first, then a contains match, so "Relationship" still finds
    // "Relationships" or "Marriage / Relationship". Oldest wins on a tie, so a
    // duplicate name can't make the target flip between runs.
    const hit = rows.find((w) => (w.name || '').trim().toLowerCase() === want)
      || rows.find((w) => (w.name || '').toLowerCase().includes(want));
    id = hit?.id || null;
    if (!id) {
      // Name drift is the likeliest failure here and it is otherwise invisible,
      // so say exactly what exists rather than just what is missing.
      console.warn(
        `  auto-file: no workspace matching "${name}" — skipping tag. Available: ` +
        (rows.map((w) => w.name).filter(Boolean).join(', ') || '(none)'),
      );
    } else if ((hit.name || '').trim().toLowerCase() !== want) {
      console.log(`  auto-file: "${name}" matched workspace "${hit.name}"`);
    }
  }

  wsCache.set(name, id);
  return id;
}

/**
 * Apply the auto-file rule to a freshly inserted reel_results row.
 * @returns {Promise<string[]>} human-readable notes about what it did
 */
export async function autoFile(supabase, result) {
  const rule = result?.category ? AUTO_FILE[result.category] : null;
  if (!rule) return [];
  const notes = [];

  if (rule.stage) {
    const { error } = await supabase
      .from('reel_results')
      .update({ stage: rule.stage, stage_at: new Date().toISOString() })
      .eq('id', result.id);
    if (error) {
      console.warn('  auto-file: stage failed —', error.message);
    } else {
      notes.push(`stage=${rule.stage}`);
      // See the header for why this logs. Separate try/catch: the stage is the
      // state, the event is only the history — losing the log must not undo it.
      const { error: evErr } = await supabase
        .from('reel_events')
        .insert({ reel_result_id: result.id, kind: rule.stage, note: 'auto-filed' });
      if (evErr) console.warn('  auto-file: event log failed —', evErr.message);
    }
  }

  if (rule.workspace) {
    const wsId = await findWorkspaceId(supabase, rule.workspace);
    if (wsId) {
      // Unique (reel_result_id, workspace_id) — ignore a duplicate rather than
      // treat a re-run as a failure.
      const { error } = await supabase
        .from('reel_board_tags')
        .upsert(
          { reel_result_id: result.id, workspace_id: wsId },
          { onConflict: 'reel_result_id,workspace_id', ignoreDuplicates: true },
        );
      if (error) console.warn('  auto-file: tag failed —', error.message);
      else notes.push(`tagged → ${rule.workspace}`);
    }
  }

  return notes;
}
