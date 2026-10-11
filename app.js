/* ---------------------------------------------------------------
 * Data model
 *
 * MULTIPLE SPOUSES: `spouseIds` is an array, because a member may marry more
 * than once (remarriage after a death or divorce). The old single `spouseId`
 * string is still accepted on import and upgraded in place, so existing saved
 * files and hand-written JSON keep loading unchanged.
 * ------------------------------------------------------------- */
/* The API is the only source of family data. The page starts empty and stays
   empty until bootstrapFromServer() resolves; there is no bundled demo tree to
   fall back to, so an empty canvas always means "the server has no data" and
   never "you are looking at placeholder rows". */
const state = {
  members: [],
  collapsed: {},
  // True when the tree differs from what the server last confirmed. Mutations
  // stay local (nothing auto-saves), so this is what warns the user before the
  // page unloads.
  dirty: false
};

const refs = {
  form: document.getElementById('memberForm'),
  name: document.getElementById('memberName'),
  sex: document.getElementById('memberSex'),
  age: document.getElementById('memberAge'),
  deceased: document.getElementById('memberDeceased'),
  spouse: document.getElementById('memberSpouse'),
  father: document.getElementById('memberFather'),
  mother: document.getElementById('memberMother'),
  submitMemberBtn: document.getElementById('submitMemberBtn'),
  cancelEditBtn: document.getElementById('cancelEditBtn'),
  treeRoot: document.getElementById('treeRoot'),
  treeCanvas: document.getElementById('treeCanvas'),
  // Created lazily by ensureCanvasWrap(); reserves the scaled footprint.
  canvasWrap: null,
  zoomInBtn: document.getElementById('zoomInBtn'),
  zoomOutBtn: document.getElementById('zoomOutBtn'),
  zoomResetBtn: document.getElementById('zoomResetBtn'),
  zoomFitBtn: document.getElementById('zoomFitBtn'),
  zoomLevelLabel: document.getElementById('zoomResetBtn'),
  searchInput: document.getElementById('memberSearch'),
  collapseAllBtn: document.getElementById('collapseAllBtn'),
  expandAllBtn: document.getElementById('expandAllBtn'),
  jsonOutput: document.getElementById('jsonOutput'),
  copyJsonBtn: document.getElementById('copyJsonBtn'),
  applyJsonBtn: document.getElementById('applyJsonBtn'),
  exportJsonBtn: document.getElementById('exportJsonBtn'),
  importJsonBtn: document.getElementById('importJsonBtn'),
  jsonFileInput: document.getElementById('jsonFileInput'),
  saveServerBtn: document.getElementById('saveServerBtn'),
  loadServerBtn: document.getElementById('loadServerBtn'),
  serverStatus: document.getElementById('serverStatus'),
  unsavedBadge: document.getElementById('unsavedBadge'),
  resetDataBtn: document.getElementById('resetDataBtn'),
  formDrawer: document.getElementById('formDrawer'),
  drawerOverlay: document.getElementById('drawerOverlay'),
  openDrawerBtn: document.getElementById('openDrawerBtn'),
  closeDrawerBtn: document.getElementById('closeDrawerBtn')
};

/* ---------------------------------------------------------------
 * Right-side drawer holding the member form
 * ------------------------------------------------------------- */
function openDrawer() {
  // Unhide first: the overlay needs a frame as a visible element before the
  // opacity transition can run, otherwise it would pop in instantly.
  refs.drawerOverlay.hidden = false;
  requestAnimationFrame(() => {
    refs.drawerOverlay.classList.add('is-open');
    refs.formDrawer.classList.add('is-open');
  });
  refs.formDrawer.setAttribute('aria-hidden', 'false');
  refs.openDrawerBtn.setAttribute('aria-expanded', 'true');
  refs.name.focus();
}

function closeDrawer() {
  refs.formDrawer.classList.remove('is-open');
  refs.drawerOverlay.classList.remove('is-open');
  refs.formDrawer.setAttribute('aria-hidden', 'true');
  refs.openDrawerBtn.setAttribute('aria-expanded', 'false');

  // Keep the overlay in the DOM until the fade-out finishes.
  setTimeout(() => {
    if (!refs.formDrawer.classList.contains('is-open')) {
      refs.drawerOverlay.hidden = true;
    }
  }, 260);
}

function isDrawerOpen() {
  return refs.formDrawer.classList.contains('is-open');
}

refs.openDrawerBtn.addEventListener('click', () => {
  resetFormMode();
  openDrawer();
});
refs.closeDrawerBtn.addEventListener('click', closeDrawer);
refs.drawerOverlay.addEventListener('click', closeDrawer);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && isDrawerOpen()) closeDrawer();
});

function getMemberById(id) {
  return state.members.find((member) => member.id === id) || null;
}

/**
 * Makes every marriage symmetric across the whole data set.
 *
 * Imported JSON is frequently one-sided — a file listing A married to B but
 * leaving B's own list empty is common in hand-edited data, and the old
 * single-field model papered over it. A half-link would make the pair render
 * differently depending on which side was examined, so both directions are
 * completed and dangling ids dropped on load.
 */
function reconcileSpouseLinks() {
  const byId = new Map(state.members.map((member) => [member.id, member]));

  state.members.forEach((member) => {
    member.spouseIds = getSpouseIds(member).filter((id) => id !== member.id && byId.has(id));
  });

  state.members.forEach((member) => {
    member.spouseIds.forEach((id) => {
      const spouse = byId.get(id);
      if (!spouse.spouseIds.includes(member.id)) spouse.spouseIds.push(member.id);
    });
  });

  // The legacy scalar is dropped once merged, so it can never disagree with
  // the array it was folded into.
  state.members.forEach((member) => {
    delete member.spouseId;
  });
}

/* ---------------------------------------------------------------
 * Spouse accessors
 *
 * Every read goes through these rather than touching `spouseIds` directly,
 * so the legacy single-string `spouseId` only has to be understood in one
 * place. Older saved files keep working without a migration step.
 * ------------------------------------------------------------- */

/** Normalised spouse id list for a member, de-duplicated and self-free. */
function getSpouseIds(member) {
  if (!member) return [];
  const raw = Array.isArray(member.spouseIds)
    ? member.spouseIds
    // Legacy shape: a single id string (or '' for unmarried).
    : (member.spouseId ? [member.spouseId] : []);
  return [...new Set(raw.filter((id) => id && id !== member.id))];
}

/** Spouse members that actually exist, in marriage order. */
function getSpouses(member) {
  return getSpouseIds(member).map((id) => getMemberById(id)).filter(Boolean);
}

/**
 * Every child with two known parents implies those parents are a couple.
 * Linking them guarantees they render side by side with a heart, so the
 * child's line drops from that heart instead of from one parent's card.
 */
function linkCoParents() {
  state.members.forEach((child) => {
    const parents = child.parentIds.filter((id) => getMemberById(id));
    if (parents.length === 2) linkSpouse(parents[0], parents[1]);
  });
}

function isMarriedTo(member, otherId) {
  return getSpouseIds(member).includes(otherId);
}

/** Adds a symmetric spouse link. Order is preserved: new marriages append. */
function linkSpouse(aId, bId) {
  if (!aId || !bId || aId === bId) return;
  const a = getMemberById(aId);
  const b = getMemberById(bId);
  if (!a || !b) return;
  a.spouseIds = [...new Set([...getSpouseIds(a), bId])];
  b.spouseIds = [...new Set([...getSpouseIds(b), aId])];
}

/** Removes a spouse link from both sides. */
function unlinkSpouse(aId, bId) {
  const a = getMemberById(aId);
  const b = getMemberById(bId);
  if (a) a.spouseIds = getSpouseIds(a).filter((id) => id !== bId);
  if (b) b.spouseIds = getSpouseIds(b).filter((id) => id !== aId);
}

/**
 * Replaces a member's entire spouse set, fixing up the other side of every
 * link that was added or dropped.
 */
function setSpouses(memberId, nextIds) {
  const member = getMemberById(memberId);
  if (!member) return;
  const next = [...new Set(nextIds.filter((id) => id && id !== memberId))];
  getSpouseIds(member)
    .filter((id) => !next.includes(id))
    .forEach((id) => unlinkSpouse(memberId, id));
  member.spouseIds = [];
  next.forEach((id) => linkSpouse(memberId, id));
}

/**
 * Parsed/imported value -> spouse id array. Accepts both the array shape and
 * the legacy single string so an older export still loads.
 */
function sanitizeSpouseIds(member) {
  const raw = Array.isArray(member.spouseIds)
    ? member.spouseIds
    : (member.spouseId ? [member.spouseId] : []);
  return [...new Set(raw.filter(Boolean).map(String))];
}

function getChildren(memberId) {
  const member = getMemberById(memberId);
  if (!member) return [];
  return member.childIds
    .map((id) => getMemberById(id))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * True when `member` can be reached by walking DOWN from somebody else, i.e.
 * somebody already renders them as a descendant.
 *
 * A member is reachable through their OWN parents, and equally through their
 * SPOUSE's parents, because a couple is drawn as a single row: whoever owns
 * the row drags the partner along with it.
 */
function isReachableFromAbove(member) {
  const hasLiveParents = (person) => person
    && person.parentIds.map((id) => getMemberById(id)).filter(Boolean).length > 0;

  if (hasLiveParents(member)) return true;
  // Any one marriage is enough: the row is drawn wherever that partner hangs.
  return getSpouses(member).some(hasLiveParents);
}

/**
 * Top-level starting points for the render.
 *
 * Only members nobody can reach from above are returned. Previous versions
 * decided this with a pairwise rule (id order, then "does my spouse have
 * parents"), which had to be re-derived for every new data shape and kept
 * letting one more case through. Reachability is the property that actually
 * matters, so it is now tested directly.
 *
 * This is deliberately NOT the only defence: renderFamilyGroup() also refuses
 * to draw a member twice. If a shape ever slips past this filter, the result
 * is a missing branch, never a duplicated one.
 */
function getRootMembers() {
  return state.members
    .filter((member) => {
      // Married-in ancestors are drawn inside the tree they marry into, above
      // the partner they belong to. Letting them stand as roots as well is
      // what used to spawn a second, parallel tree.
      if (inlineAncestorIds.has(member.id)) return false;
      if (isReachableFromAbove(member)) return false;

      /* Every member of a parentless marriage cluster qualifies; keep one.
         With multiple spouses the cluster can be larger than two (A-B and
         A-C are one row), so the whole connected group is collected and the
         lowest id elected, rather than comparing a single pair. */
      const cluster = getMarriageCluster(member.id)
        .filter((person) => !isReachableFromAbove(person));
      if (cluster.length > 1) {
        return cluster.every((person) => member.id.localeCompare(person.id) <= 0);
      }
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function matchesTreeQuery(member) {
  const query = refs.searchInput.value.trim().toLowerCase();
  if (!query) return true;
  return member.name.toLowerCase().includes(query);
}

function hasMatchingDescendant(memberId) {
  const query = refs.searchInput.value.trim().toLowerCase();
  if (!query) return true;

  const member = getMemberById(memberId);
  if (!member) return false;

  if (member.name.toLowerCase().includes(query)) return true;

  for (const childId of member.childIds) {
    if (hasMatchingDescendant(childId)) return true;
  }

  return false;
}

/* ---------------------------------------------------------------
 * Married-in ancestors
 *
 * A couple hangs beneath its parents, but a married pair has TWO sets of
 * parents. Once both partners have a parent branch, the pair is reachable
 * from both sides. Treating both sides as top-level roots grows a second,
 * parallel tree next to the first — the pair appears twice and the branch
 * lines land on the wrong copy.
 *
 * The real relationship is not two trees: it is one tree into which the
 * partner's parents MARRY IN. So exactly one side keeps the descending
 * lineage (the side with the deeper ancestry — the tree's own bloodline),
 * and the other side's ancestors are drawn in place, stacked directly above
 * the partner they belong to, inside the existing couple row.
 *
 * `inlineAncestorIds` are therefore suppressed as roots: they already render
 * inside the tree and must not also start one of their own.
 * ------------------------------------------------------------- */
let inlineAncestorIds = new Set();
// memberId -> true when that member's parents render above their own card.
let inlineAncestorFor = new Set();

/** Longest chain of parents above `memberId`. Deeper = more established line. */
function getAncestorDepth(memberId, seen = new Set()) {
  if (seen.has(memberId)) return 0;
  seen.add(memberId);

  const member = getMemberById(memberId);
  if (!member || !member.parentIds.length) return 0;

  let deepest = 0;
  member.parentIds.forEach((parentId) => {
    deepest = Math.max(deepest, 1 + getAncestorDepth(parentId, new Set(seen)));
  });
  return deepest;
}

/** Every ancestor of `memberId`, including each ancestor's spouse. */
function collectAncestors(memberId, out = new Set(), seen = new Set()) {
  if (seen.has(memberId)) return out;
  seen.add(memberId);

  const member = getMemberById(memberId);
  if (!member) return out;

  member.parentIds.forEach((parentId) => {
    const parent = getMemberById(parentId);
    if (!parent) return;
    out.add(parent.id);
    getSpouseIds(parent).forEach((spouseId) => out.add(spouseId));
    collectAncestors(parent.id, out, seen);
  });
  return out;
}

/**
 * Decides, for every couple whose partners BOTH have parents, which side
 * keeps the descending lineage and which side's ancestors are drawn inline.
 * Recomputed per render pass because any edit can change the shape.
 */
function computeInlineAncestors() {
  inlineAncestorIds = new Set();
  inlineAncestorFor = new Set();

  /* Decided per marriage CLUSTER, not per pair. With several spouses the row
     holds 3+ people who may each have parents, and only ONE of them can keep
     the descending lineage — electing a winner pairwise would mark the same
     person as both owner and married-in depending on which pair was examined,
     and the loser's branch would render twice. */
  const handled = new Set();

  state.members.forEach((member) => {
    if (handled.has(member.id)) return;

    const cluster = getMarriageCluster(member.id);
    cluster.forEach((person) => handled.add(person.id));
    if (cluster.length < 2) return;

    const withParents = cluster.filter((person) => person.parentIds.length);
    // Nobody competes for the lineage unless at least two sides have parents.
    if (withParents.length < 2) return;

    // Deepest ancestry keeps the lineage. Ties fall back to name order purely
    // so the layout is stable rather than dependent on traversal order.
    const owner = withParents.reduce((best, person) => {
      const bestDepth = getAncestorDepth(best.id);
      const personDepth = getAncestorDepth(person.id);
      if (personDepth > bestDepth) return person;
      if (personDepth === bestDepth && person.name.localeCompare(best.name) < 0) return person;
      return best;
    });

    const ownerAncestors = collectAncestors(owner.id);

    withParents
      .filter((person) => person.id !== owner.id)
      .forEach((marriedIn) => {
        /* Both partners descend from the SAME tree (e.g. cousins): the
           married-in side's parents are already drawn in the main lineage,
           so there is nothing to stack inline. Their line is drawn as a
           cross-link from that parents' heart instead (see
           renderFamilyGroup / drawBranchConnectors). */
        const ownParents = marriedIn.parentIds.filter((id) => getMemberById(id));
        if (ownParents.every((id) => ownerAncestors.has(id))) return;
        inlineAncestorFor.add(marriedIn.id);
        // Only ancestors exclusive to the married-in side move inline;
        // anything shared with the owner's line stays in the main tree.
        collectAncestors(marriedIn.id).forEach((id) => {
          if (!ownerAncestors.has(id)) inlineAncestorIds.add(id);
        });
      });
  });
}

/**
 * Everyone joined to `memberId` through marriage links, transitively.
 *
 * With one spouse this is just the pair. With several it is the whole group
 * drawn in one row (A+B and A+C share A, so all three sit together), which
 * is why root election has to look at a cluster rather than at a pair.
 */
function getMarriageCluster(memberId) {
  const seen = new Set();
  const queue = [memberId];

  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    const person = getMemberById(id);
    if (!person) continue;
    seen.add(id);
    getSpouseIds(person).forEach((spouseId) => {
      if (!seen.has(spouseId)) queue.push(spouseId);
    });
  }

  return [...seen].map((id) => getMemberById(id)).filter(Boolean);
}

/**
 * The cards making up one couple row, in left-to-right order.
 *
 * The row is the whole marriage CLUSTER, not just the member's own partners.
 * If A is married to B and C, then rendering the group from B must still show
 * C: they all share one row, and leaving C out would drop her from the tree
 * entirely whenever traversal happened to arrive via B.
 *
 * Order matters because hearts are drawn between ADJACENT cards: every
 * married pair has to end up side by side, or the row would imply a marriage
 * that does not exist. The cluster is therefore walked as a chain, starting
 * from an end (the least-married person) and stepping along real marriages,
 * which puts a hub between its partners automatically. A plain two-person
 * couple reduces to the original name ordering.
 */
function getCoupleMembers(memberId) {
  const member = getMemberById(memberId);
  if (!member) return [];

  const cluster = getMarriageCluster(memberId);
  if (cluster.length < 2) return [member];

  const byName = (a, b) => a.name.localeCompare(b.name);
  const degree = (person) => getSpouseIds(person).length;

  /* Does this marriage have children of its own?
   *
   * In a branching cluster (a hub with 3+ partners) no ordering can make
   * every marriage adjacent, and only adjacent marriages get a heart. A
   * marriage WITH children needs its heart far more than a childless one:
   * without it there is nothing for the children's stem to drop from, and
   * they degrade to hanging off the hub's card as if the other parent were
   * unknown. Fertile marriages therefore win the adjacent slots. */
  const hasIssue = (a, b) => state.members.some(
    (child) => child.parentIds.includes(a.id) && child.parentIds.includes(b.id)
  );

  /* Start at an endpoint so the walk runs along the chain rather than
     beginning in the middle and stranding one side. Among equal endpoints a
     parent is preferred, for the same reason as above: the first step is
     guaranteed adjacency, so it should be spent on a marriage that needs a
     heart to hang children from. */
  const isParent = (person) => state.members.some(
    (child) => child.parentIds.includes(person.id) && child.parentIds.length > 1
  );
  const start = [...cluster].sort((a, b) => degree(a) - degree(b)
    || (isParent(b) ? 1 : 0) - (isParent(a) ? 1 : 0)
    || byName(a, b))[0];

  const ordered = [];
  const placed = new Set();
  let current = start;

  while (current) {
    ordered.push(current);
    placed.add(current.id);
    /* Prefer the most-married unplaced partner, so a hub is reached before
       its leaves and the chain does not dead-end early. Among equals, a
       marriage that produced children is stepped to first so it keeps its
       heart when the cluster branches and someone has to lose theirs. */
    const from = current;
    current = getSpouses(current)
      .filter((person) => !placed.has(person.id))
      .sort((a, b) => degree(b) - degree(a)
        || (hasIssue(from, b) ? 1 : 0) - (hasIssue(from, a) ? 1 : 0)
        || byName(a, b))[0] || null;
  }

  /* Anyone the single walk could not reach — only possible in a branching
     cluster, e.g. a hub with three partners, where no ordering can make every
     pair adjacent. They are appended next to a partner where possible so the
     card is never lost; a marriage that still ends up non-adjacent simply
     renders without its heart rather than drawing a false one. */
  cluster
    .filter((person) => !placed.has(person.id))
    .sort(byName)
    .forEach((person) => {
      const anchor = ordered.findIndex((item) => isMarriedTo(item, person.id));
      if (anchor === -1) {
        ordered.push(person);
        placed.add(person.id);
        return;
      }

      /* Insert beside the anchor WITHOUT displacing a marriage that already
         has its heart. Splicing straight after the anchor would push the
         anchor's existing neighbour out of adjacency, silently destroying a
         heart that was already correctly placed — and, if that marriage had
         children, the stem they drop from. Only a side whose current
         neighbour is not married to the anchor may be taken; if neither is
         free this person goes to the end of the row, keeping a heart they
         could never have had in exchange for none of anyone else's. */
      const freeAfter = anchor === ordered.length - 1
        || !isMarriedTo(ordered[anchor], ordered[anchor + 1].id);
      const freeBefore = anchor === 0
        || !isMarriedTo(ordered[anchor], ordered[anchor - 1].id);

      if (freeAfter) ordered.splice(anchor + 1, 0, person);
      else if (freeBefore) ordered.splice(anchor, 0, person);
      else ordered.push(person);
      placed.add(person.id);
    });

  return ordered;
}

function getDirectChildrenForParentSet(parentIds) {
  const parentSet = new Set(parentIds.filter(Boolean));

  return state.members
    .filter((member) => {
      if (!member.parentIds.length) return false;
      return member.parentIds.some((parentId) => parentSet.has(parentId));
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/* ---------------------------------------------------------------
 * Father / mother resolution
 *
 * parentIds stays a flat array so existing data and exported JSON keep
 * working, but the two slots are no longer interchangeable. Position is an
 * unreliable key on its own: [father, mother].filter(Boolean) collapses to a
 * single entry when one is missing, so index 0 can legitimately be a mother.
 * Sex is therefore the primary signal, with position only as a fallback for
 * records whose parent is missing or carries sex 'other'.
 * ------------------------------------------------------------- */
function getParentsBySex(member) {
  if (!member || !member.parentIds.length) return { father: null, mother: null };

  const parents = member.parentIds.map((id) => getMemberById(id)).filter(Boolean);
  let father = parents.find((parent) => parent.sex === 'male') || null;
  let mother = parents.find((parent) => parent.sex === 'female') || null;

  // Fall back to slot order for parents that aren't male/female, so an
  // 'other' parent still surfaces instead of silently disappearing.
  const unresolved = parents.filter((parent) => parent !== father && parent !== mother);
  unresolved.forEach((parent) => {
    if (!father) father = parent;
    else if (!mother) mother = parent;
  });

  return { father, mother };
}

function syncSelectOptions() {
  const editingId = refs.form.dataset.editId || '';
  const options = state.members
    .filter((member) => member.id !== editingId)
    .map((member) => {
      const option = document.createElement('option');
      option.value = member.id;
      option.textContent = `${member.name} (${member.sex})`;
      // Read back by fillSelect() to filter the father/mother lists.
      option.dataset.sex = member.sex;
      return option;
    });

  // The father/mother selects are filtered by sex so the two slots can't be
  // filled with two men. 'other' stays eligible for both rather than being
  // excluded from the tree entirely.
  const fillSelect = (select, allowed) => {
    const currentValue = select.value;
    select.innerHTML = '<option value="">None</option>';
    options
      .filter((option) => !allowed || allowed.includes(option.dataset.sex))
      .forEach((option) => select.appendChild(option.cloneNode(true)));
    // Only restore a value the filtered list still offers, otherwise the
    // select would silently fall back to "None" on a stale id.
    select.value = currentValue && select.querySelector(`option[value="${CSS.escape(currentValue)}"]`)
      ? currentValue
      : '';
  };

  /* The spouse list box has no "None" row — in a multi-select, selecting
     nothing already means none, and a None option would just be a value that
     has to be filtered back out. Existing selections are preserved across the
     rebuild so re-syncing never silently drops a marriage. */
  const selectedSpouseIds = getSelectedSpouseIds();
  refs.spouse.innerHTML = '';
  options.forEach((option) => refs.spouse.appendChild(option.cloneNode(true)));
  setSelectedSpouseIds(selectedSpouseIds);

  fillSelect(refs.father, ['male', 'other']);
  fillSelect(refs.mother, ['female', 'other']);
}

/** Currently ticked ids in the spouse list box. */
function getSelectedSpouseIds() {
  return [...refs.spouse.selectedOptions].map((option) => option.value).filter(Boolean);
}

/** Ticks exactly `ids` in the spouse list box, ignoring ids not on offer. */
function setSelectedSpouseIds(ids) {
  const wanted = new Set(ids);
  [...refs.spouse.options].forEach((option) => {
    option.selected = wanted.has(option.value);
  });
}

function updateJsonOutput() {
  refs.jsonOutput.value = JSON.stringify({ members: state.members }, null, 2);
}

/* Copy for the "nothing to draw" canvas. Set by the API layer so the same
   blank canvas can explain *why* it is blank — still loading, genuinely empty,
   or a failed request — instead of always claiming there is no data. */
const EMPTY_STATE = {
  LOADING: { title: 'Loading family data…', hint: 'Fetching the tree from the server.' },
  NONE: { title: 'No family data exists', hint: 'Add a member to start building the tree.' },
  ERROR: { title: 'No family data loaded', hint: 'The server could not be reached. Use “Load from Server” to retry.' }
};

let emptyStateView = EMPTY_STATE.LOADING;

/** Points the blank canvas at one of the EMPTY_STATE variants and repaints. */
function setEmptyStateView(view) {
  emptyStateView = view || EMPTY_STATE.NONE;
  // Only the empty canvas shows this; with members on screen it is a no-op.
  if (!state.members.length) updateTree();
}

function renderEmptyState() {
  const view = emptyStateView;
  refs.treeCanvas.innerHTML =
    `<div class="empty-state">
       <p class="empty-state__title">${escapeHtml(view.title)}</p>
       <p class="empty-state__hint">${escapeHtml(view.hint)}</p>
     </div>`;
}

function updateTree() {
  // Cards are rebuilt from scratch, so any open popover is anchored to a
  // trigger that is about to be discarded.
  closeFloat();
  refs.treeCanvas.innerHTML = '';
  /* Must run BEFORE getRootMembers(): it decides which ancestors are drawn
     inline, and those are exactly the ones root selection has to skip. */
  computeInlineAncestors();
  // Fresh pass: nothing has been drawn yet.
  renderedMemberIds = new Set();

  const roots = getRootMembers();
  if (!roots.length) {
    renderEmptyState();
    applyCentering();
    return;
  }

  const branch = document.createElement('div');
  branch.className = 'family-branch';

  roots.forEach((member) => {
    if (!matchesTreeQuery(member) && !hasMatchingDescendant(member.id)) return;
    branch.appendChild(renderFamilyGroup(member));
  });

  if (!branch.childElementCount) {
    refs.treeCanvas.innerHTML =
      `<div class="empty-state">
         <p class="empty-state__title">No matching family member found</p>
         <p class="empty-state__hint">Try a different search term.</p>
       </div>`;
    applyCentering();
    return;
  }

  /* Recovery pass.
     Every member in a parent cycle is "reachable from above", so none of them
     qualifies as a root and the whole group would silently vanish. Anything
     still undrawn is therefore started as its own root. The once-only guard
     makes this safe: it can only ever recover missing branches, never add a
     duplicate. Skipped during a search, where omissions are intentional. */
  if (!refs.searchInput.value.trim()) {
    state.members.forEach((member) => {
      if (renderedMemberIds.has(member.id)) return;
      if (inlineAncestorIds.has(member.id)) return;
      branch.appendChild(renderFamilyGroup(member));
    });
  }

  refs.treeCanvas.appendChild(branch);
  /* Must run after insertion: both passes measure rendered geometry, which
     has no value until the tree is in the document. Anchors first — the jog
     each stem needs is measured from where that stem actually ended up, so
     the stems have to be in their final positions before it is computed. */
  reserveInlineAncestorSpace();
  alignCoupleAnchors();
  /* Anchoring shifts rows inside a stack with margins, which widens the
     stack AFTER its overflow was reserved. Reserve again so neighbouring
     branches are pushed clear of the stack's final width. */
  reserveInlineAncestorSpace();
  extendIncomingDrops();
  drawBranchConnectors();
  // Content size changed, so the centring offset must be recomputed.
  applyCentering();
}

/* ---------------------------------------------------------------
 * Member card
 *
 * The card is now just a name row with two icon triggers. Everything
 * else lives in a floating layer:
 *   - info icon  -> popover with spouse / parents / age
 *   - more icon  -> menu with edit / add child / delete
 *
 * WHY A BODY-LEVEL LAYER: cards sit inside .tree-canvas, which is
 * CSS-`transform: scale()`d by the zoom controls and clipped by the
 * card's own `overflow: hidden`. A popover rendered inside the card
 * would be scaled with it (unreadable at 40%, huge at 300%) and cut
 * off at the card edge. Rendering into document.body and positioning
 * from the trigger's getBoundingClientRect() — which already reports
 * post-zoom screen coordinates — keeps the popover at a constant,
 * legible size wherever the card happens to be.
 * ------------------------------------------------------------- */

const ICONS = {
  info: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6v.4"/></svg>',
  more: '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>',
  edit: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  addChild: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="7" r="3.2"/><path d="M12 10.2V15"/><path d="M12 19.5v-1.2"/><path d="M9.6 19.5h4.8"/><path d="M18 17v5M15.5 19.5h5"/></svg>',
  addFather: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="10" cy="6.5" r="3"/><path d="M4.5 20v-3.5A5.5 5.5 0 0 1 10 11a5.5 5.5 0 0 1 3.4 1.2"/><path d="M18 15v6M15 18h6"/></svg>',
  addMother: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="10" cy="6.5" r="3"/><path d="M10 11v9"/><path d="M6.2 14.5h7.6"/><path d="M18 15v6M15 18h6"/></svg>',
  addSpouse: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="6.5" cy="7" r="2.8"/><circle cx="14.5" cy="7" r="2.8"/><path d="M2.5 19v-2.6A4.4 4.4 0 0 1 6.9 12h.2"/><path d="M10.5 19v-2.6A4.4 4.4 0 0 1 14.9 12h.2"/><path d="M19 15v6M16 18h6"/></svg>',
  delete: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/></svg>',
  collapse: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/></svg>',
  expand: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/></svg>'
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

// Age bounds, kept in sync with the min/max on #memberAge.
const AGE_MIN = 0;
const AGE_MAX = 130;
// Distinct from '' (legitimately "not set") so the caller can tell a blank
// field apart from a value that was supplied but unusable.
const INVALID_AGE = Symbol('invalid-age');

/**
 * Form input -> stored value. Blank means "not set" and is stored as ''
 * to match the other optional fields. Anything non-numeric or out of range
 * returns INVALID_AGE so submission can be blocked.
 */
function normalizeAge(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';

  const value = Number(text);
  if (!Number.isFinite(value)) return INVALID_AGE;

  const whole = Math.floor(value);
  if (whole < AGE_MIN || whole > AGE_MAX) return INVALID_AGE;
  return whole;
}

/**
 * Imported/pasted JSON -> stored value. Unlike the form path this never
 * rejects: a bad age in one record shouldn't abort the whole import, so
 * unusable values degrade to '' (not set).
 */
function sanitizeAge(raw) {
  const value = normalizeAge(raw);
  return value === INVALID_AGE ? '' : value;
}

/**
 * Imported/pasted JSON -> stored deceased flag. Older exports predate this
 * field, so a missing value means "living" rather than invalid. Strings are
 * accepted because hand-edited JSON and some exporters emit "true"/"false".
 */
function sanitizeDeceased(raw) {
  if (typeof raw === 'string') return raw.trim().toLowerCase() === 'true';
  return raw === true;
}

/**
 * Age is optional in the data model. An explicit `age` wins; otherwise a
 * `dob` is converted. Returns null when neither is usable so the popover
 * can show a placeholder rather than "NaN".
 */
function getMemberAge(member) {
  if (member.age !== '' && member.age !== null && member.age !== undefined) {
    const direct = Number(member.age);
    if (!isNaN(direct) && direct >= 0) return Math.floor(direct);
  }

  if (!member.dob) return null;
  const born = new Date(member.dob);
  if (isNaN(born.getTime())) return null;

  const now = new Date();
  let age = now.getFullYear() - born.getFullYear();
  // Birthday not yet reached this year.
  const monthDiff = now.getMonth() - born.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < born.getDate())) age -= 1;
  return age >= 0 ? age : null;
}

/* ---- floating layer (popover + menu) ---- */

let openFloat = null; // { el, trigger }

function closeFloat() {
  if (!openFloat) return;
  openFloat.el.remove();
  if (openFloat.trigger && openFloat.trigger.isConnected) {
    openFloat.trigger.setAttribute('aria-expanded', 'false');
  }
  openFloat = null;
}

/**
 * Places `el` under `trigger` in viewport coordinates, flipping above and
 * clamping horizontally so it never leaves the window.
 */
function positionFloat(el, trigger) {
  const anchor = trigger.getBoundingClientRect();
  const GAP = 6;
  const MARGIN = 8;
  const { width, height } = el.getBoundingClientRect();

  let left = anchor.left + anchor.width / 2 - width / 2;
  left = clamp(left, MARGIN, Math.max(MARGIN, window.innerWidth - width - MARGIN));

  let top = anchor.bottom + GAP;
  // Flip above when there isn't room below.
  if (top + height > window.innerHeight - MARGIN) {
    const above = anchor.top - GAP - height;
    top = above >= MARGIN ? above : Math.max(MARGIN, window.innerHeight - height - MARGIN);
  }

  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

function openFloatEl(el, trigger) {
  closeFloat();
  document.body.appendChild(el);
  // Measure after insertion; the element has no size until it is in the DOM.
  positionFloat(el, trigger);
  trigger.setAttribute('aria-expanded', 'true');
  openFloat = { el, trigger };
}

function buildInfoPopover(member) {
  const el = document.createElement('div');
  el.className = 'member-pop member-pop--info';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', `Details for ${member.name}`);

  // All marriages are listed, so a second spouse is never hidden behind the
  // first. The label is pluralised to match.
  const spouses = getSpouses(member);
  const spouseLabel = spouses.length > 1 ? 'Spouses' : 'Spouse';
  const spouseName = spouses.length
    ? spouses.map((spouse) => escapeHtml(spouse.name)).join('<br>')
    : 'Single';
  const { father, mother } = getParentsBySex(member);
  const age = getMemberAge(member);
  const notSet = '<span class="is-empty">Not set</span>';

  el.innerHTML = `
    <div class="member-pop__title">${escapeHtml(member.name)}</div>
    <dl class="member-pop__list">
      <dt>${spouseLabel}</dt><dd>${spouseName}</dd>
      <dt>Father</dt><dd>${father ? escapeHtml(father.name) : notSet}</dd>
      <dt>Mother</dt><dd>${mother ? escapeHtml(mother.name) : notSet}</dd>
      <dt>Age</dt><dd>${age === null ? notSet : escapeHtml(age)}</dd>
      <dt>Status</dt><dd>${member.deceased ? 'Deceased' : 'Living'}</dd>
    </dl>
  `;
  return el;
}

function buildActionMenu(member) {
  const el = document.createElement('div');
  el.className = 'member-pop member-menu';
  el.setAttribute('role', 'menu');
  el.setAttribute('aria-label', `Actions for ${member.name}`);

  const items = [
    { action: 'edit', label: 'Edit', icon: ICONS.edit },
    { action: 'quick-add-child', label: 'Add Child', icon: ICONS.addChild }
  ];

  /* A member has at most one father and one mother, so each action is offered
     only while its slot is actually free. Re-pointing an occupied slot is a
     reassignment, not an add, and already has a home in Edit. */
  const { father, mother } = getParentsBySex(member);
  if (!father) {
    items.push({ action: 'quick-add-father', label: 'Add Father', icon: ICONS.addFather });
  }
  if (!mother) {
    items.push({ action: 'quick-add-mother', label: 'Add Mother', icon: ICONS.addMother });
  }

  /* Unlike the parent slots, this is NOT gated: a member may marry more than
     once, so there is no single slot to fill up. The label switches once a
     marriage exists, to make clear the action adds another rather than
     replacing the current one. */
  items.push({
    action: 'quick-add-spouse',
    label: getSpouseIds(member).length ? 'Add Another Spouse' : 'Add Spouse',
    icon: ICONS.addSpouse
  });

  // Collapse/expand has no other home now that the card is icon-only, so it
  // joins the menu whenever the member actually has children to hide.
  if (getChildren(member.id).length) {
    const collapsed = !!state.collapsed[member.id];
    items.push({
      action: collapsed ? 'expand' : 'collapse',
      label: collapsed ? 'Expand' : 'Collapse',
      icon: collapsed ? ICONS.expand : ICONS.collapse
    });
  }

  items.push({ action: 'delete', label: 'Delete', icon: ICONS.delete, danger: true });

  items.forEach((item) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('role', 'menuitem');
    btn.className = `member-menu__item${item.danger ? ' is-danger' : ''}`;
    btn.innerHTML = `${item.icon}<span>${item.label}</span>`;
    btn.addEventListener('click', () => {
      closeFloat();
      runMemberAction(item.action, member.id);
    });
    el.appendChild(btn);
  });

  return el;
}

function runMemberAction(action, memberId) {
  if (action === 'edit') {
    populateFormForMember(memberId);
    openDrawer();
  } else if (action === 'quick-add-child') {
    prepareQuickAddChildForm(memberId);
    openDrawer();
  } else if (action === 'quick-add-father') {
    prepareQuickAddParentForm(memberId, 'father');
    openDrawer();
  } else if (action === 'quick-add-mother') {
    prepareQuickAddParentForm(memberId, 'mother');
    openDrawer();
  } else if (action === 'quick-add-spouse') {
    prepareQuickAddSpouseForm(memberId);
    openDrawer();
  } else if (action === 'delete') {
    removeMember(memberId);
  } else if (action === 'collapse') {
    toggleCollapse(memberId, true);
  } else if (action === 'expand') {
    toggleCollapse(memberId, false);
  }
}

function renderMemberCard(member) {
  const card = document.createElement('div');
  // `is-deceased` greys the whole card; it is applied alongside the sex class
  // rather than replacing it so the name colour is still defined underneath
  // and returns intact if the flag is unchecked later.
  card.className = `member-card ${member.sex}${member.deceased ? ' is-deceased' : ''}`;
  card.dataset.memberId = member.id;

  const row = document.createElement('div');
  row.className = 'member-row';

  const name = document.createElement('span');
  name.className = 'member-name';
  name.textContent = member.name;
  // Grey alone is a colour-only signal, so the state is also carried in text
  // for screen readers and on hover.
  name.title = member.deceased ? `${member.name} (deceased)` : member.name;

  const tools = document.createElement('div');
  tools.className = 'member-tools';

  const infoBtn = document.createElement('button');
  infoBtn.type = 'button';
  infoBtn.className = 'member-icon-btn';
  infoBtn.innerHTML = ICONS.info;
  infoBtn.title = 'Details';
  infoBtn.setAttribute('aria-label', `Details for ${member.name}`);
  infoBtn.setAttribute('aria-haspopup', 'dialog');
  infoBtn.setAttribute('aria-expanded', 'false');
  infoBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    // Second click on the same trigger closes it.
    if (openFloat && openFloat.trigger === infoBtn) {
      closeFloat();
      return;
    }
    openFloatEl(buildInfoPopover(member), infoBtn);
  });

  const moreBtn = document.createElement('button');
  moreBtn.type = 'button';
  moreBtn.className = 'member-icon-btn';
  moreBtn.innerHTML = ICONS.more;
  moreBtn.title = 'More actions';
  moreBtn.setAttribute('aria-label', `More actions for ${member.name}`);
  moreBtn.setAttribute('aria-haspopup', 'menu');
  moreBtn.setAttribute('aria-expanded', 'false');
  moreBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    if (openFloat && openFloat.trigger === moreBtn) {
      closeFloat();
      return;
    }
    const menu = buildActionMenu(member);
    openFloatEl(menu, moreBtn);
    const first = menu.querySelector('.member-menu__item');
    if (first) first.focus();
  });

  tools.appendChild(infoBtn);
  tools.appendChild(moreBtn);
  row.appendChild(name);
  row.appendChild(tools);
  card.appendChild(row);
  return card;
}

// Dismiss the floating layer on outside click, Escape, or any viewport change
// that would leave it anchored to the wrong place.
document.addEventListener('mousedown', (event) => {
  if (!openFloat) return;
  if (openFloat.el.contains(event.target) || openFloat.trigger.contains(event.target)) return;
  closeFloat();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && openFloat) {
    const trigger = openFloat.trigger;
    closeFloat();
    if (trigger && trigger.isConnected) trigger.focus();
  }
});

window.addEventListener('resize', closeFloat);

/** A heart badge, used as the visual marriage link between two cards. */
function createHeart() {
  const heart = document.createElement('div');
  heart.className = 'couple-heart';
  heart.textContent = '❤';
  return heart;
}

/**
 * Appends the cards of a couple row, putting a heart between each ADJACENT
 * pair that is actually married.
 *
 * The adjacency test matters once a member has several spouses: the row is
 * ordered hub-in-the-middle so every partner neighbours the hub, but a heart
 * must still only be drawn where a real marriage exists — never between two
 * partners who merely sit next to each other.
 *
 * `renderCard` is injected so the main tree can wrap a card in its inline
 * ancestor stack while the simple rows pass a plain renderer.
 */
function appendCoupleCards(row, coupleMembers, renderCard) {
  coupleMembers.forEach((coupleMember, index) => {
    if (index > 0 && isMarriedTo(coupleMembers[index - 1], coupleMember.id)) {
      const heart = createHeart();
      // Lets the caller tint this heart to match the stem and children of the
      // same marriage.
      heart.dataset.marriageKey = [coupleMembers[index - 1].id, coupleMember.id].sort().join('+');
      row.appendChild(heart);
    }
    row.appendChild(renderCard(coupleMember));
  });
}

/* ---------------------------------------------------------------
 * Marriage tints
 *
 * A row with one marriage needs no tint — there is nothing to tell apart, and
 * colouring it would only add noise. From two marriages up, each is given a
 * stable colour shared by its heart, its stem and its children's branch
 * lines, so a child can be traced to the couple it belongs to.
 *
 * Colours are assigned from the marriage key rather than from a counter, so a
 * marriage keeps its colour as other marriages are added or removed and the
 * tree does not re-colour itself on every edit.
 * ------------------------------------------------------------- */
/* Hue angle of each .couple-tint-N in styles.css, in the same order. Kept
   here so collisions can be resolved by actual colour distance rather than
   by slot number — slots 1 and 2 being "adjacent" means nothing visually. */
const TINT_HUES = [265, 205, 145, 85, 25, 325];
const TINT_COUNT = TINT_HUES.length;

function tintIndexFor(key) {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return hash % TINT_COUNT;
}

// Shortest distance between two hues on the 360-degree wheel.
function hueDistance(a, b) {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/**
 * Assigns a tint class to every marriage in ONE row, returning a key -> class
 * map.
 *
 * Hashing the key alone was not enough: with six slots, two marriages in the
 * same row could hash to the same slot and render in the identical colour —
 * precisely the case the tint exists to disambiguate. So the hash is only a
 * starting preference. If it is already taken, the marriage is given whichever
 * free slot is FURTHEST IN HUE from the ones already used in this row, which
 * both guarantees distinctness and maximises contrast between the branches
 * that sit side by side.
 *
 * Groups are walked in sorted key order, not render order, so a marriage keeps
 * its colour when another is added or removed, or when the row is reordered.
 *
 * A row with a single marriage gets no tint: there is nothing to tell apart
 * and colouring it would only add noise.
 */
function buildTintMap(groupKeys) {
  const map = new Map();
  if (groupKeys.length < 2) return map;

  const used = [];
  const taken = new Set();

  [...groupKeys].sort().forEach((key) => {
    let index = tintIndexFor(key);

    if (taken.has(index)) {
      let best = -1;
      let bestScore = -1;
      for (let candidate = 0; candidate < TINT_COUNT; candidate += 1) {
        if (taken.has(candidate)) continue;
        // Distance to the NEAREST colour already in the row is what decides
        // legibility, so maximise that minimum.
        const score = used.reduce(
          (min, usedIndex) => Math.min(min, hueDistance(TINT_HUES[candidate], TINT_HUES[usedIndex])),
          Infinity
        );
        if (score > bestScore) {
          bestScore = score;
          best = candidate;
        }
      }
      // More marriages than colours: fall back to the hashed slot and repeat
      // a colour rather than leaving the branch untinted.
      index = best === -1 ? index : best;
    }

    if (!taken.has(index)) {
      taken.add(index);
      used.push(index);
    }
    map.set(key, `couple-tint-${index + 1}`);
  });

  return map;
}

function renderCoupleRow(member) {
  const coupleMembers = getCoupleMembers(member.id);
  const row = document.createElement('div');
  row.className = 'couple-row';
  appendCoupleCards(row, coupleMembers, renderMemberCard);
  return row;
}

/**
 * Flat left-to-right description of a couple row: card, heart, card, ...
 *
 * A heart is emitted only between adjacent people who are actually married,
 * so a multi-spouse row never implies a marriage between two partners that
 * merely sit next to each other.
 */
function buildCoupleLayout(coupleMembers) {
  const layout = [];
  coupleMembers.forEach((person, index) => {
    if (index > 0 && isMarriedTo(coupleMembers[index - 1], person.id)) {
      layout.push({ type: 'heart', between: [coupleMembers[index - 1].id, person.id] });
    }
    layout.push({ type: 'card', id: person.id });
  });
  return layout;
}

/**
 * Splits a row's children into the marriage each one came from.
 *
 * This is the piece that answers "which child belongs to which couple". A row
 * can hold several marriages, and their children are NOT siblings — they are
 * half-siblings who merely share one parent. Each group therefore gets its own
 * heart, its own stem and its own sibling bus.
 *
 * A child is assigned to a marriage when BOTH of that marriage's partners are
 * its parents, so it can only ever land in one group. Children who match no
 * marriage (one known parent, or a parent outside this row) fall into a
 * trailing group anchored on the blood member's own card: that card is the
 * only point in the row common to all of them, and hanging them off a heart
 * would claim a second parent the data does not have.
 *
 * Groups are returned in row order so the children render left-to-right in
 * the same sequence as the hearts above them, which is what keeps each bus an
 * unbroken contiguous run.
 */
function groupChildrenByMarriage(layout, children, bloodId) {
  const groups = [];
  const claimed = new Set();

  layout.forEach((slot, index) => {
    if (slot.type !== 'heart') return;
    const members = children.filter((child) => slot.between.every((id) => child.parentIds.includes(id)));
    if (!members.length) return;
    members.forEach((child) => claimed.add(child.id));
    groups.push({ slotIndex: index, key: [...slot.between].sort().join('+'), children: members });
  });

  let rest = children.filter((child) => !claimed.has(child.id));

  /* A child recorded with only ONE parent, whose parent has exactly one
     spouse, is still drawn from that marriage's heart — a line leaving the
     card beside a heart reads as a broken connection. */
  const blood = getMemberById(bloodId);
  const ownHearts = layout
    .map((slot, index) => ({ slot, index }))
    .filter(({ slot }) => slot.type === 'heart' && slot.between.includes(bloodId));
  if (rest.length && blood && getSpouseIds(blood).length === 1 && ownHearts.length === 1) {
    const { slot, index } = ownHearts[0];
    const key = [...slot.between].sort().join('+');
    const existing = groups.find((group) => group.key === key);
    if (existing) existing.children.push(...rest);
    else groups.push({ slotIndex: index, key, children: rest });
    rest = [];
  }

  if (rest.length) {
    const cardIndex = layout.findIndex((slot) => slot.type === 'card' && slot.id === bloodId);
    groups.push({ slotIndex: cardIndex, key: `solo:${bloodId}`, children: rest });
  }

  return groups.sort((a, b) => a.slotIndex - b.slotIndex);
}

/**
 * Horizontal distance from the row's own centre to the centre of the slot at
 * `targetIndex`, as a CSS length.
 *
 * The old implementation could express this with two fixed classes
 * (anchor-left / anchor-right) because a row was always exactly card-heart-card,
 * making the offset a constant. With several spouses a row can hold any number
 * of cards and hearts, so the offset is measured from the real layout instead:
 * count the cards, hearts and gaps lying before the target, and compare that
 * against half the row. Returned as calc() so it still tracks the CSS size
 * tokens rather than hard-coding pixel values.
 */
function getSlotOffset(layout, targetIndex) {
  if (targetIndex < 0 || layout.length < 2) return '0px';

  const totalCards = layout.filter((slot) => slot.type === 'card').length;
  const totalHearts = layout.length - totalCards;
  const totalGaps = layout.length - 1;

  const before = layout.slice(0, targetIndex);
  const cardsBefore = before.filter((slot) => slot.type === 'card').length;
  const heartsBefore = before.length - cardsBefore;

  const isCard = layout[targetIndex].type === 'card';
  const halfSelf = isCard ? 0.5 : 0;

  const cardTerm = cardsBefore + (isCard ? halfSelf : 0) - totalCards / 2;
  const heartTerm = heartsBefore + (isCard ? 0 : 0.5) - totalHearts / 2;
  const gapTerm = before.length - totalGaps / 2;

  return `calc(${cardTerm} * var(--card-w) + ${heartTerm} * var(--heart-w) + ${gapTerm} * var(--couple-gap))`;
}

/**
 * Ancestors of a married-in partner, drawn directly above that partner's own
 * card inside the existing couple row.
 *
 * This is what keeps the tree single. The partner's parents are real members
 * with real cards and a real connector down to their child — they are simply
 * rendered at this point in the tree rather than as a separate root, so the
 * pair below them is never duplicated.
 */
function renderInlineAncestors(member, side = 'right') {
  const { father, mother } = getParentsBySex(member);
  const parents = [father, mother].filter(Boolean);
  if (!parents.length) return null;
  /* Once-only rule: when two lines share ancestors (e.g. both partners
     descend from the same grandparents), the shared couple is drawn by
     whichever stack reaches it first; every later path stops here instead
     of painting a duplicate copy. */
  if (parents.some((parent) => renderedMemberIds.has(parent.id))) return null;
  // Claimed before recursing so a deeper path cannot loop back and redraw them.
  parents.forEach((parent) => renderedMemberIds.add(parent.id));

  const stack = document.createElement('div');
  stack.className = 'inline-ancestors';

  // Grandparents and beyond continue upward recursively, so a married-in
  // side with several generations stays fully visible. `side` is the
  // direction AWAY from the main lineage; every level grows that way so a
  // married-in family never reaches back across the blood line's connectors.
  // Evaluated lazily: only ONE grand stack is displayed, so rendering the
  // others would claim their members as drawn while discarding the cards.
  /* BOTH parents' ancestries are drawn (e.g. Nagarajan's parents AND
     Geetha's parents). Each grand stack sits above its own parent: the
     lineage parent (moved to the outward end below) gets the outward slot,
     the other parent's stack sits on the inward side. */
  const grandStacks = [];
  for (const parent of parents) {
    const gs = renderInlineAncestors(parent, side);
    if (gs) grandStacks.push({ parent, gs });
  }
  const grandStack = grandStacks.length ? grandStacks[0].gs : null;
  if (grandStacks.length === 1) {
    stack.appendChild(grandStack);
  } else if (grandStacks.length > 1) {
    const pair = document.createElement('div');
    pair.className = 'inline-ancestor-pair';
    const ordered = side === 'right' ? [...grandStacks].reverse() : grandStacks;
    ordered.forEach(({ gs }) => pair.appendChild(gs));
    stack.appendChild(pair);
  }

  const row = document.createElement('div');
  row.className = 'couple-row inline-ancestor-row has-children';

  /* The row is the parents' whole marriage CLUSTER, not just the one or two
     people who are this member's parents.
     computeInlineAncestors() suppresses every ancestor it moves inline as a
     root, and collectAncestors() counts each ancestor's SPOUSES as ancestors
     too. So a parent's other husband/wife is barred from starting a branch of
     their own, and if this row drew only [father, mother] they would never be
     drawn anywhere — vanishing from the tree entirely. Rendering the cluster
     is what keeps a remarried ancestor's other partners visible.

     Only childless extras are folded in. A partner who has children of their
     own is left out on purpose: their offspring hang off their own branch,
     and claiming the card here would mark them rendered and silently collapse
     that branch to nothing. They keep rendering as a separate group, exactly
     as before. */
  const rowMembers = [];
  const seen = new Set();
  parents.forEach((parent) => {
    getCoupleMembers(parent.id).forEach((person) => {
      if (seen.has(person.id)) return;
      const isBloodParent = parents.some((item) => item.id === person.id);
      /* A partner moved inline by computeInlineAncestors() is barred from
         being a root, so this row is the ONLY place they can be drawn —
         they must be included even if they have children (e.g. a second
         wife whose child sits in the sibling slots). Only partners that
         still render through their own branch are left out. */
      if (!isBloodParent && person.childIds.length && !inlineAncestorIds.has(person.id)) return;
      seen.add(person.id);
      rowMembers.push(person);
    });
  });

  /* A parent whose own parents are drawn in the grand stack above may have
     brothers/sisters too (e.g. an aunt). They are only reachable through that
     stack, so they are drawn here beside that parent — on the OUTWARD side,
     and that parent is moved to the outward end of the couple. Placing them
     inward would make their parents' bus cut across the main lineage's lines. */
  const lineageParent = grandStack
    ? parents.find((parent) => parent.parentIds.some((id) => getMemberById(id)))
    : null;
  if (lineageParent && rowMembers.length === 2) {
    const other = rowMembers.find((person) => person.id !== lineageParent.id);
    rowMembers.splice(0, 2, ...(side === 'right' ? [other, lineageParent] : [lineageParent, other]));
  }

  // These cards are real renderings of real members, so they count towards
  // the once-only rule just like any other card.
  rowMembers.forEach((person) => renderedMemberIds.add(person.id));

  /* Where this row's stem drops from: the parents' heart when both are known,
     otherwise the single blood parent's card. The row may hold extra cards
     (a remarried ancestor's other partners), so its geometric centre is NOT
     the right place — without this the stem would drop from whichever card
     happened to land in the middle. Resolved to a real element and measured
     by alignCoupleAnchors() once the row has been laid out. */
  const stemAnchorKey = parents.length > 1
    ? parents.map((parent) => parent.id).sort().join('+')
    : `solo:${parents[0].id}`;
  row.dataset.anchorKey = stemAnchorKey;
  // The child this stack belongs to; drawInlineConnectors() drops onto it.
  row.dataset.childId = member.id;
  const inlineLayout = buildCoupleLayout(rowMembers);
  const inlineAnchorIndex = findAnchorSlotIndex(inlineLayout, stemAnchorKey);
  if (inlineAnchorIndex > -1) {
    const offset = getSlotOffset(inlineLayout, inlineAnchorIndex);
    row.classList.add('is-anchored');
    row.style.setProperty('--anchor-offset', offset);
    row.style.setProperty('--stem-offset', offset);
  }
  // Hearts are emitted only between ADJACENT people who are really married,
  // so a three-card row never implies a marriage between two partners that
  // merely sit next to each other — nor between mere co-parents.
  /* Siblings are drawn for EVERY parent whose own parents are in a grand
     stack above (e.g. Nagarajan's siblings AND Geetha's siblings). Each set
     goes on that parent's outer side, away from the partner. */
  const stackParentIds = new Set(grandStacks.map(({ parent }) => parent.id));
  appendCoupleCards(row, rowMembers, (person) => {
    const card = renderMemberCard(person);
    if (!stackParentIds.has(person.id)) return card;
    const siblings = renderInlineSiblings(person);
    if (!siblings.length) return card;
    const fragment = document.createDocumentFragment();
    const isLineage = lineageParent && person.id === lineageParent.id;
    const pos = rowMembers.findIndex((item) => item.id === person.id);
    const siblingsLeft = rowMembers.length === 2 && !isLineage
      ? pos === 0
      : side === 'left';
    if (siblingsLeft) {
      siblings.forEach((slot) => fragment.appendChild(slot));
      fragment.appendChild(card);
    } else {
      fragment.appendChild(card);
      siblings.forEach((slot) => fragment.appendChild(slot));
    }
    return fragment;
  });

  stack.appendChild(row);
  return stack;
}

/**
 * Other children of a married-in partner's parents, each rendered as a full
 * branch (with their own spouse and children) in a slot beside that partner.
 */
function renderInlineSiblings(member) {
  const parentIds = member.parentIds.filter((id) => getMemberById(id));
  if (!parentIds.length) return [];

  return getDirectChildrenForParentSet(parentIds)
    .filter((child) => child.id !== member.id
      && !renderedMemberIds.has(child.id)
      // A sibling who married into another lineage is drawn there instead.
      && !inlineAncestorFor.has(child.id))
    .map((child) => {
      const group = renderFamilyGroup(child);
      if (!group.childElementCount) return null;
      const slot = document.createElement('div');
      slot.className = 'inline-sibling';
      slot.dataset.siblingOf = member.id;
      slot.appendChild(group);
      return slot;
    })
    .filter(Boolean);
}

/* Members already drawn in the current render pass.
   Reset by updateTree() before every rebuild. */
let renderedMemberIds = new Set();

/**
 * Joins every stem to the bus of its own marriage.
 *
 * A stem drops from its heart, but that heart is rarely directly above the
 * children it feeds — the row is anchored on the blood member's card, and
 * each group of children sits wherever its run landed in the children row.
 * The horizontal distance between the two depends on real rendered widths
 * (card count, name lengths, how deep each subtree is), so it cannot be
 * expressed in CSS and is measured here after layout.
 *
 * A short horizontal jog is added when the two do not already line up; when
 * they do, nothing is drawn and the stem stays a clean straight drop.
 */
/**
 * Finds the slot a marriage key refers to: the heart of that marriage, or
 * the card itself for a `solo:` key.
 */
function findAnchorSlotIndex(layout, key) {
  if (key.startsWith('solo:')) {
    const id = key.slice(5);
    return layout.findIndex((slot) => slot.type === 'card' && slot.id === id);
  }
  return layout.findIndex(
    (slot) => slot.type === 'heart' && [...slot.between].sort().join('+') === key
  );
}

/**
 * Pays for the horizontal overflow of every inline ancestor stack.
 *
 * .member-with-ancestors is pinned to one card width so the stack cannot
 * inflate its owner's flex slot and tear the heart away from the card it
 * marries. The stack itself is wider than that and spills out of the column
 * on both sides. Spilling is only safe if somebody reserves the room: left
 * unpaid, the stack would be drawn over the branch sitting beside it.
 *
 * The overflow is therefore measured and added as PADDING on the enclosing
 * .family-group. Padding participates in layout, so the group genuinely
 * grows and its siblings are pushed clear — the same reason .is-anchored
 * uses margin rather than transform.
 *
 * Also fixes the heart's vertical position: in a bottom-aligned row the
 * heart is lifted off the card's bottom edge by a fixed CSS offset, which
 * assumes the tallest slot is one card high. With a stack present the
 * column is far taller, so the correction is re-derived per row from the
 * card's real distance to the row's bottom.
 */
function reserveInlineAncestorSpace() {
  const zoom = zoomLevel || 1;

  /* Deepest first: an outer stack contains the inner ones, so the padding an
     inner stack adds changes the outer stack's width. Measuring outside-in
     would measure geometry that is about to grow. */
  const columns = [...refs.treeCanvas.querySelectorAll('.member-with-ancestors')].reverse();

  columns.forEach((column) => {
    const stack = column.querySelector(':scope > .inline-ancestors');
    const group = column.closest('.family-group');
    if (!stack || !group) return;

    const colRect = column.getBoundingClientRect();
    const stackRect = stack.getBoundingClientRect();
    if (!colRect.width || !stackRect.width) return;

    const overflowLeft = Math.max(0, (colRect.left - stackRect.left) / zoom);
    const overflowRight = Math.max(0, (stackRect.right - colRect.right) / zoom);

    /* Accumulated with max(), not assigned: one group can hold several
       stacks (a row where more than one partner married in), and the group
       has to be wide enough for the worst of them on each side. */
    const prevLeft = parseFloat(group.dataset.reservedLeft || '0');
    const prevRight = parseFloat(group.dataset.reservedRight || '0');
    const left = Math.max(prevLeft, overflowLeft);
    const right = Math.max(prevRight, overflowRight);

    group.dataset.reservedLeft = String(left);
    group.dataset.reservedRight = String(right);
    group.style.paddingLeft = `${left}px`;
    group.style.paddingRight = `${right}px`;
  });

  alignInlineRows();
}

/**
 * Lines up the cards of brothers and sisters in one children row.
 *
 * A child whose spouse carries an inline ancestor stack has their card pushed
 * down by that stack, while a sibling without one stays at the row's top. Each
 * branch is pushed down so every child's own card shares the same top edge.
 */
function alignChildrenRows() {
  const zoom = zoomLevel || 1;
  [...refs.treeCanvas.querySelectorAll('.children-row')].reverse().forEach((wrap) => {
    const branches = [...wrap.querySelectorAll(':scope > .child-branch')];
    branches.forEach((b) => { b.style.marginTop = ''; });
    const offsets = branches.map((branch) => {
      const card = branch.querySelector(
        ':scope > .couple-row > .member-card, :scope > .couple-row > .member-with-ancestors > .member-card'
      );
      return card ? (card.getBoundingClientRect().top - branch.getBoundingClientRect().top) / zoom : 0;
    });
    const top = Math.max(0, ...offsets);
    branches.forEach((branch, i) => {
      const shift = top - offsets[i];
      if (shift > 0.5) branch.style.marginTop = `${shift}px`;
    });
  });
}

/**
 * Lines up every card in a row that carries an ancestor stack.
 *
 * Top-aligned, with each slot pushed down by the stack height, so all cards
 * (including sibling branches that hang their own children below) share one
 * top edge. Bottom alignment could not do this: a sibling with children is
 * taller than a card and would drag every other card down with it.
 */
function alignInlineRows() {
  const zoom = zoomLevel || 1;
  [...refs.treeCanvas.querySelectorAll('.couple-row.has-inline-ancestors')].reverse().forEach((row) => {
    row.style.alignItems = 'flex-start';
    const slots = [...row.children].filter(
      (child) => !child.matches('.couple-stem, .incoming-drop, .branch-lines')
    );
    slots.forEach((slot) => { slot.style.marginTop = ''; slot.style.marginBottom = ''; });

    const offsets = slots.map((slot) => {
      if (!slot.matches('.member-with-ancestors')) return 0;
      const card = slot.querySelector(':scope > .member-card');
      return card ? (card.getBoundingClientRect().top - slot.getBoundingClientRect().top) / zoom : 0;
    });
    const top = Math.max(0, ...offsets);

    slots.forEach((slot, i) => {
      if (slot.classList.contains('couple-heart')) {
        slot.style.marginTop = `calc(${top}px + var(--couple-line-y) - var(--heart-w) / 2)`;
        slot.style.marginBottom = '0';
      } else {
        slot.style.marginTop = `${top - offsets[i]}px`;
      }
    });
  });
}

/**
 * Re-measures every row anchor and stem from real rendered geometry.
 *
 * getSlotOffset() computes where a card or heart sits by COUNTING slots and
 * multiplying by --card-w. That is only correct while every slot really is
 * one card wide. It stops being correct as soon as a partner carries an
 * inline ancestor stack: the stack is a column that can be far wider than a
 * single card (its own couple row, plus that row's own stacks above it), so
 * the real centres drift further and further from the predicted ones the
 * deeper the married-in lineage goes. Every connector anchored to a
 * predicted offset — the incoming arrowhead, the outgoing stem, the jog
 * measured from it — then lands somewhere in open space, which is the
 * visible symptom of a branch "breaking".
 *
 * The true offsets are only knowable after layout, so they are read back
 * here and written over the estimate in px. Measuring is safe to do before
 * the anchor margins are applied: those margins move the row AND everything
 * in it together, so a child's offset relative to the row's own centre is
 * unchanged by them.
 */
function alignCoupleAnchors() {
  const zoom = zoomLevel || 1;

  /* Deepest row first.
     An inline ancestor row lives INSIDE one of its descendant row's cards,
     so re-anchoring it changes that card's width and therefore every
     measurement in the row around it. Document order gives the outer row
     first, which would measure against a column that is about to move;
     reversing it settles each stack before anything that contains it. */
  [...refs.treeCanvas.querySelectorAll('.couple-row[data-anchor-key]')].reverse().forEach((row) => {
    const target = findAnchorElement(row, row.dataset.anchorKey);
    if (!target) return;

    const rowRect = row.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    if (!rowRect.width || !targetRect.width) return;

    const offset = (targetRect.left + targetRect.width / 2
      - (rowRect.left + rowRect.width / 2)) / zoom;

    row.classList.add('is-anchored');
    row.style.setProperty('--anchor-offset', `${offset}px`);
    row.style.setProperty('--stem-offset', `${offset}px`);
  });

  refs.treeCanvas.querySelectorAll('.couple-stem').forEach((stem) => {
    const row = stem.parentElement;
    const target = findAnchorElement(row, stem.dataset.groupKey);
    if (!target) return;

    const rowRect = row.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    if (!rowRect.width || !targetRect.width) return;

    stem.style.setProperty('--stem-x', `${(targetRect.left + targetRect.width / 2
      - (rowRect.left + rowRect.width / 2)) / zoom}px`);

    /* The stem is positioned at the row's bottom edge, but the heart sits
       higher, on the cards' name line. Lift the stem's top up to the heart's
       lower edge so the line visibly leaves the heart instead of floating
       below it. Solo (card) stems already start at the card's bottom. */
    const lift = target.classList.contains('couple-heart')
      ? Math.max(0, (rowRect.bottom - targetRect.bottom) / zoom)
      : 0;
    stem.style.setProperty('--stem-lift', `${lift}px`);
  });
}

/**
 * Carries the incoming parent line down to the blood member's card.
 *
 * A row holding a married-in partner's ancestor stack is bottom-aligned, so
 * the blood member's card sits at the BOTTOM of a much taller row. The
 * incoming arrowhead is drawn at the row's top edge, so without this it
 * lands level with the stack — visually on whichever card of the stack sits
 * beside it (e.g. pointing at a spouse's mother instead of the real child).
 */
function extendIncomingDrops() {
  const zoom = zoomLevel || 1;
  refs.treeCanvas.querySelectorAll('.child-branch > .couple-row.has-inline-ancestors').forEach((row) => {
    row.querySelectorAll(':scope > .incoming-drop').forEach((el) => el.remove());
    row.style.removeProperty('--incoming-drop');

    const card = findAnchorElement(row, `solo:${row.dataset.bloodId}`);
    if (!card) return;

    const drop = (card.getBoundingClientRect().top - row.getBoundingClientRect().top) / zoom;
    if (drop < 1) return;

    const line = document.createElement('div');
    line.className = 'incoming-drop';
    line.style.height = `${drop}px`;
    row.appendChild(line);
    row.style.setProperty('--incoming-drop', `${drop}px`);
  });
}

/**
 * The element a marriage key points at within one row: that marriage's heart,
 * or the member's own card for a `solo:` key.
 *
 * Scoped to direct descendants of the row, so a row holding an inline
 * ancestor stack cannot match a card or heart belonging to a GENERATION
 * ABOVE it — those are nested inside the stack and would otherwise be found
 * first by an unscoped lookup, dragging the anchor up and sideways.
 */
function findAnchorElement(row, key) {
  if (!row || !key) return null;

  if (key.startsWith('solo:')) {
    const id = key.slice(5);
    return [...row.children]
      .map((child) => (child.matches('.member-card')
        ? child
        : child.querySelector(':scope > .member-card')))
      .find((card) => card && card.dataset.memberId === id) || null;
  }

  return [...row.children].find(
    (child) => child.classList.contains('couple-heart')
      && child.dataset.marriageKey === key
  ) || null;
}

/**
 * Draws every parent -> children connector from measured geometry.
 *
 * One SVG per family-group, rebuilt on every render. For each marriage:
 *   stem   : heart (or solo parent card) bottom  -> bus line
 *   bus    : horizontal, spanning the stem and every child of that marriage
 *   drops  : bus -> top of each child's own card, ending in an arrowhead
 * Because every segment is computed from the same measured points, they
 * always meet, whatever the number of children or their subtree widths.
 */
const SVG_NS = 'http://www.w3.org/2000/svg';

/* ---------------------------------------------------------------
 * Branch colours + click-to-isolate
 *
 * Every parent -> children connector gets its own colour, stepped round
 * the hue wheel by the golden angle so neighbouring branches always differ
 * strongly, even where their lines cross or run side by side.
 *
 * Clicking a branch line isolates it: only that line and the cards it
 * joins stay visible, everything else is faded. Clicking anywhere else
 * (another line, empty canvas) shows the whole tree again.
 * ------------------------------------------------------------- */
let branchCounter = 0;
let branchElements = new Map();
let isolatedBranchId = null;

/* The source of a line is a heart (couple) or a single card; for a heart the
   two partner cards beside it are the parents. */
function parentEndpoints(source) {
  if (!source) return [];
  const out = [source];
  if (!source.classList.contains('member-card')) {
    [source.previousElementSibling, source.nextElementSibling].forEach((el) => {
      if (!el) return;
      // A partner carrying an inline ancestor stack is wrapped one level down.
      const card = el.classList.contains('member-card') ? el : el.querySelector(':scope > .member-card');
      if (card) out.push(card);
    });
  }
  return out;
}

function nextBranchColor() {
  const hue = Math.round((branchCounter * 137.508) % 360);
  return `hsl(${hue}, 70%, 42%)`;
}

function clearBranchIsolation() {
  isolatedBranchId = null;
  refs.treeCanvas.classList.remove('branch-isolated');
  refs.treeCanvas.querySelectorAll('.branch-focus').forEach((el) => el.classList.remove('branch-focus'));
}

function isolateBranch(id) {
  clearBranchIsolation();
  const entry = branchElements.get(id);
  if (!entry) return;
  isolatedBranchId = id;
  refs.treeCanvas.classList.add('branch-isolated');
  entry.forEach((el) => {
    el.classList.add('branch-focus');
    // A card is only readable if the row holding it is visible too.
    const card = el.closest && el.closest('.member-card');
    if (card) card.classList.add('branch-focus');
  });
}

/* Appends one branch (line + arrowheads) to `svg` and registers the cards
   it connects so the branch can be isolated on click. */
function appendBranch(svg, d, targets, color, endpoints) {
  branchCounter += 1;
  const id = `b${branchCounter}`;
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'branch-path');
  g.dataset.branchId = id;

  // Wide transparent stroke: a 2px line is too thin to click reliably.
  const hit = document.createElementNS(SVG_NS, 'path');
  hit.setAttribute('d', d);
  hit.setAttribute('class', 'branch-hit');
  g.appendChild(hit);

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', color);
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'square');
  g.appendChild(path);

  targets.forEach((t) => {
    const arrow = document.createElementNS(SVG_NS, 'path');
    arrow.setAttribute('d', `M${t.x - 5} ${t.y - 8}H${t.x + 5}L${t.x} ${t.y}Z`);
    arrow.setAttribute('fill', color);
    g.appendChild(arrow);
  });

  g.addEventListener('click', (event) => {
    event.stopPropagation();
    if (isolatedBranchId) clearBranchIsolation();
    else isolateBranch(id);
  });

  svg.appendChild(g);
  branchElements.set(id, [g, ...endpoints.filter(Boolean)]);
}

/* Listened on the stage, not the canvas: drag-to-pan captures the pointer
   on the stage, so empty-space clicks are delivered there. A drag that
   actually panned is not treated as a click. */
let branchPressPoint = null;
refs.treeRoot.addEventListener('pointerdown', (event) => {
  branchPressPoint = { x: event.clientX, y: event.clientY };
});
refs.treeRoot.addEventListener('click', (event) => {
  if (!isolatedBranchId) return;
  if (event.target.closest('.branch-path')) return;
  if (branchPressPoint
    && Math.hypot(event.clientX - branchPressPoint.x, event.clientY - branchPressPoint.y) > 4) return;
  clearBranchIsolation();
});

function drawBranchConnectors() {
  const zoom = zoomLevel || 1;
  refs.treeCanvas.querySelectorAll('.branch-lines').forEach((el) => el.remove());
  clearBranchIsolation();
  branchCounter = 0;
  branchElements = new Map();

  refs.treeCanvas.querySelectorAll('.family-group').forEach((group) => {
    const row = group.querySelector(':scope > .couple-row');
    const childrenWrap = group.querySelector(':scope > .children-row');
    if (!row || !childrenWrap) return;

    const stems = [...row.querySelectorAll(':scope > .couple-stem')];
    if (!stems.length) return;

    const groupRect = group.getBoundingClientRect();
    if (!groupRect.width) return;
    const toX = (x) => (x - groupRect.left) / zoom;
    const toY = (y) => (y - groupRect.top) / zoom;

    const wrapRect = childrenWrap.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(childrenWrap).paddingTop) || 14;
    // Bus sits in the middle of the space between the parents and children.
    const busY = toY(wrapRect.top) + gap;

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'branch-lines');
    svg.setAttribute('width', String(groupRect.width / zoom));
    svg.setAttribute('height', String(groupRect.height / zoom));

    stems.forEach((stem, index) => {
      const source = findAnchorElement(row, stem.dataset.groupKey);
      if (!source) return;
      const srcRect = source.getBoundingClientRect();
      const sx = toX(srcRect.left + srcRect.width / 2);
      const sy = toY(srcRect.bottom);

      const targets = [...childrenWrap.children]
        .filter((branch) => branch.dataset.groupKey === stem.dataset.groupKey)
        .map((branch) => {
          const childRow = branch.querySelector(':scope > .couple-row');
          const card = childRow && findAnchorElement(childRow, childRow.dataset.anchorKey);
          if (!card) return null;
          const r = card.getBoundingClientRect();
          return { x: toX(r.left + r.width / 2), y: toY(r.top), el: card };
        })
        .filter(Boolean);

      // Children drawn elsewhere in the tree (beside a spouse from another
      // branch): the bus is extended to their single existing card.
      const remoteRoutes = [];
      (stem.dataset.remoteIds ? stem.dataset.remoteIds.split(',') : []).forEach((id) => {
        const card = group.querySelector(`.member-card[data-member-id="${CSS.escape(id)}"]`);
        if (!card) return;
        const r = card.getBoundingClientRect();
        const tx = toX(r.left + r.width / 2);
        const ty = toY(r.top);
        /* The card sits a generation lower, inside a sibling's branch. A
           straight drop would run through that sibling's own card, so the
           line travels down the gap beside that branch, then across just
           above the card. */
        /* Pick the vertical lane from the REAL card/heart positions: the
           target's own x when nothing is in the way (a straight drop),
           otherwise the gap closest to it. Using the branch box edge
           sent the line to padding far from any card, which read as a
           broken connection. */
        const obstacles = [...group.querySelectorAll('.member-card, .couple-heart')]
          .filter((el) => el !== card)
          .map((el) => {
            const r = el.getBoundingClientRect();
            return { l: toX(r.left), r: toX(r.right), t: toY(r.top), b: toY(r.bottom) };
          })
          .filter((o) => o.r > o.l);
        const yTop = busY - 10;
        const yBottom = ty - 12;
        const clear = (x) => !obstacles.some((o) => x > o.l - 6 && x < o.r + 6
          && o.b > yTop && o.t < yBottom);
        const candidates = [tx, ...obstacles.flatMap((o) => [o.l - 10, o.r + 10])]
          .sort((a, b) => Math.abs(a - tx) - Math.abs(b - tx));
        const laneX = candidates.find(clear);
        if (laneX === undefined || Math.abs(laneX - tx) < 0.5) {
          targets.push({ x: tx, y: ty, el: card });
          return;
        }
        remoteRoutes.push({ laneX, x: tx, y: ty, el: card });
      });
      if (!targets.length && !remoteRoutes.length) return;

      // Separate marriages get slightly different bus heights so their
      // horizontal lines can never merge into one.
      const y = busY + (stems.length > 1 ? (index - (stems.length - 1) / 2) * 6 : 0);
      const xs = [sx, ...targets.map((t) => t.x), ...remoteRoutes.map((t) => t.laneX)];
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);

      let d = `M${sx} ${sy}V${y}`;
      if (maxX - minX > 0.5) d += `M${minX} ${y}H${maxX}`;
      targets.forEach((t) => { d += `M${t.x} ${y}V${t.y - 7}`; });
      remoteRoutes.forEach((t) => {
        const turnY = t.y - 12;
        d += `M${t.laneX} ${y}V${turnY}H${t.x}V${t.y - 7}`;
        targets.push({ x: t.x, y: t.y, el: t.el });
      });

      appendBranch(svg, d, targets, nextBranchColor(),
        [...parentEndpoints(source), ...targets.map((t) => t.el)]);
    });

    if (svg.childNodes.length) group.appendChild(svg);
  });

  drawInlineConnectors();
}

/**
 * Same stem / bus / drops, for married-in parents drawn in an inline stack:
 * heart -> the partner's card below, plus every sibling slot beside it.
 */
function drawInlineConnectors() {
  const zoom = zoomLevel || 1;
  const color = getComputedStyle(document.documentElement).getPropertyValue('--connector').trim() || '#7a4ddb';

  refs.treeCanvas.querySelectorAll('.inline-ancestor-row').forEach((row) => {
    const source = findAnchorElement(row, row.dataset.anchorKey);
    const stack = row.parentElement;
    let scope = stack && stack.parentElement;
    // Side-by-side grand stacks are wrapped; the child row lives one level up.
    if (scope && scope.classList.contains('inline-ancestor-pair')) scope = scope.parentElement;
    const host = row.closest('.family-group');
    const childId = row.dataset.childId;
    if (!source || !scope || !host || !childId) return;

    const cards = [];
    const own = scope.querySelector(
      `:scope > .member-card[data-member-id="${childId}"], :scope > .couple-row > .member-card[data-member-id="${childId}"]`
    );
    if (own) cards.push(own);

    /* Sibling slots live in the couple row that holds this column — or, for
       an ancestor inside a stack, in that ancestor's own couple row. */
    const coupleRow = scope.matches('.member-with-ancestors')
      ? scope.parentElement
      : (own && own.parentElement);
    if (coupleRow) {
      coupleRow.querySelectorAll(`:scope > .inline-sibling[data-sibling-of="${childId}"]`).forEach((slot) => {
        const childRow = slot.querySelector(':scope > .family-group > .couple-row');
        const card = (childRow && findAnchorElement(childRow, childRow.dataset.anchorKey))
          || slot.querySelector('.member-card');
        if (card) cards.push(card);
      });
    }
    if (!cards.length) return;

    const hostRect = host.getBoundingClientRect();
    const toX = (x) => (x - hostRect.left) / zoom;
    const toY = (y) => (y - hostRect.top) / zoom;

    const srcRect = source.getBoundingClientRect();
    const sx = toX(srcRect.left + srcRect.width / 2);
    const sy = toY(srcRect.bottom);
    const targets = cards.map((card) => {
      const r = card.getBoundingClientRect();
      return { x: toX(r.left + r.width / 2), y: toY(r.top) };
    });
    const busY = Math.min(...targets.map((t) => t.y)) - 14;
    const xs = [sx, ...targets.map((t) => t.x)];
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);

    let d = `M${sx} ${sy}V${busY}`;
    if (maxX - minX > 0.5) d += `M${minX} ${busY}H${maxX}`;
    targets.forEach((t) => { d += `M${t.x} ${busY}V${t.y - 7}`; });

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'branch-lines');
    svg.setAttribute('width', String(hostRect.width / zoom));
    svg.setAttribute('height', String(hostRect.height / zoom));

    appendBranch(svg, d, targets, nextBranchColor(), [...parentEndpoints(source), ...cards]);
    host.appendChild(svg);
  });
}

function alignCoupleStems() {
  refs.treeCanvas.querySelectorAll('.couple-stem').forEach((stem) => {
    const group = stem.closest('.family-group');
    const childrenWrap = group && group.querySelector(':scope > .children-row');
    if (!childrenWrap) return;

    const mates = [...childrenWrap.children].filter(
      (branch) => branch.dataset.groupKey === stem.dataset.groupKey
    );
    if (!mates.length) return;

    /* The bus spans the centres of the first and last child in the group, so
       the stem may meet it anywhere between them. A solo child has a zero
       width bus, so the stem must land exactly on that child's centre. */
    const stemRect = stem.getBoundingClientRect();
    const first = mates[0].getBoundingClientRect();
    const last = mates[mates.length - 1].getBoundingClientRect();
    const zoom = zoomLevel || 1;

    const busLeft = first.left + first.width / 2;
    const busRight = last.left + last.width / 2;
    const stemX = stemRect.left + stemRect.width / 2;

    // Already over its own bus: a straight drop is correct, no jog needed.
    if (stemX >= busLeft - 1 && stemX <= busRight + 1) return;

    const targetX = stemX < busLeft ? busLeft : busRight;
    // Screen pixels are post-zoom; divide back out so the jog is authored in
    // the canvas's own unscaled coordinate space like every other connector.
    const delta = (targetX - stemX) / zoom;

    const jog = document.createElement('div');
    jog.className = 'couple-stem__jog';
    jog.style.width = `${Math.abs(delta)}px`;
    // Drawn at the bus depth, i.e. the bottom of the stem.
    jog.style.top = `calc(var(--connector-gap) / 2 + var(--stem-lift, 0px))`;
    jog.style.left = delta < 0 ? `${delta}px` : '0px';
    stem.appendChild(jog);
  });
}

function renderFamilyGroup(member) {
  const wrapper = document.createElement('div');
  wrapper.className = 'family-group';

  const coupleMembers = getCoupleMembers(member.id);

  /* Last line of defence against the duplicate tree.
     Root selection decides where traversal STARTS; this decides what may be
     drawn, and it cannot be fooled by a data shape nobody anticipated. A
     cycle (A parent of B, B parent of A) would otherwise recurse forever,
     and any member reachable by two paths would be painted twice.
     Marked before descending so a cycle terminates on re-entry. */
  if (coupleMembers.some((person) => renderedMemberIds.has(person.id))) {
    return wrapper;
  }
  coupleMembers.forEach((person) => renderedMemberIds.add(person.id));
  const parentIds = coupleMembers.length > 1
    ? coupleMembers.map((item) => item.id)
    : [member.id];

  const query = refs.searchInput.value.trim().toLowerCase();
  const shouldShowCouple = !query || coupleMembers.some((person) => person.name.toLowerCase().includes(query));

  const unorderedChildren = getDirectChildrenForParentSet(parentIds).filter((child) => !query || hasMatchingDescendant(child.id));

  const layout = buildCoupleLayout(coupleMembers);
  const bloodIndex = layout.findIndex(
    (slot) => slot.type === 'card' && slot.id === member.id
  );

  /* Children split by the marriage they came from, and then FLATTENED back in
     group order. Rendering them in this order is what lets each marriage own
     an unbroken run of the children row, so its bus can be cut from the next
     group's without interleaving. */
  const childGroups = groupChildrenByMarriage(layout, unorderedChildren, member.id);
  const children = childGroups.flatMap((group) => group.children);

  /* Built once per row and shared by the couple row and the children row
     below it — the two must agree, and the assignment depends on the whole
     set of marriages in the row, not on any one of them. */
  const tintMap = buildTintMap(childGroups.map((group) => group.key));

  if (shouldShowCouple) {
    const coupleRow = document.createElement('div');
    const isChildOnly = member.parentIds.length > 0;
    const showsChildren = children.length > 0 && !state.collapsed[member.id];

    /* Anchoring puts the blood member's card on the group's centre line,
       which is what the INCOMING line and the whole subtree below align to.
       Stems start elsewhere in the row (at their own hearts), so each one
       carries its own offset relative to that same centre. */
    const needsAnchor = showsChildren || isChildOnly;
    const anchorOffset = needsAnchor ? getSlotOffset(layout, bloodIndex) : '0px';

    coupleRow.className = `couple-row ${showsChildren ? 'has-children' : 'no-children'} ${isChildOnly ? 'child-only' : ''}`;

    /* Lets alignCoupleAnchors() re-measure the anchor from real geometry
       after layout. The offset below is only a first estimate: it assumes
       every slot is exactly --card-w wide, which stops being true the moment
       one partner carries an inline ancestor stack. */
    if (needsAnchor) coupleRow.dataset.anchorKey = `solo:${member.id}`;

    if (needsAnchor && coupleMembers.length > 1) {
      /* Shift the row so the blood member's card lands on the group centre,
         using MARGIN rather than transform so the group still reserves the
         width and neighbouring branches are pushed clear instead of
         overlapped. --anchor-offset is the distance from the row's own
         centre to that card, so the row moves by the negative of it. */
      coupleRow.classList.add('is-anchored');
      coupleRow.style.setProperty('--anchor-offset', anchorOffset);
      coupleRow.style.setProperty('--stem-offset', anchorOffset);
    }

    /* One stem per marriage, each dropping from its own heart.
     *
     * Previously a single shared trunk had to pick ONE start point for the
     * whole row, so adding a spouse moved that point onto the new marriage
     * and the existing children appeared to change parents. Giving every
     * marriage its own stem removes the choice entirely: an added spouse
     * adds a stem and leaves the others exactly where they were. */
    /* One tint map for the whole row, so the stem, the heart and the
       children of a marriage cannot drift onto different colours, and so no
       two marriages in this row can share one. */
    const tintFor = (key) => tintMap.get(key) || '';

    if (showsChildren) {
      coupleRow.classList.add('has-stems');
      childGroups.forEach((group) => {
        const stem = document.createElement('div');
        stem.className = `couple-stem ${tintFor(group.key)}`.trim();
        stem.style.setProperty('--stem-x', getSlotOffset(layout, group.slotIndex));
        // Read back by alignCoupleStems() to find this stem's own children.
        stem.dataset.groupKey = group.key;
        coupleRow.appendChild(stem);
      });
    }

    appendCoupleCards(coupleRow, coupleMembers, (coupleMember) => {
      /* A married-in partner carries their own parents stacked above their
         card, inside this same row. That is what keeps one tree: those
         ancestors are suppressed as roots, so this is their only rendering
         and the couple below them is never drawn a second time. */
      if (!inlineAncestorFor.has(coupleMember.id)) {
        return renderMemberCard(coupleMember);
      }
      const column = document.createElement('div');
      column.className = 'member-with-ancestors';
      const outward = coupleMembers.indexOf(coupleMember) > coupleMembers.indexOf(member)
        ? 'right'
        : 'left';
      const ancestors = renderInlineAncestors(coupleMember, outward);
      /* The stack is wider than the card. Centred, it spills over the spouse
         on the other side of the heart and sits across that spouse's incoming
         line. Pin it to the inward edge so it only grows outward. */
      column.classList.add(`grow-${outward}`);
      if (ancestors) column.appendChild(ancestors);
      column.appendChild(renderMemberCard(coupleMember));

      /* Brothers/sisters of the married-in partner. Their parents only exist
         in the inline stack above, so this is the only place they can be
         drawn joined to them. Placed on the far side from the spouse so the
         marriage heart stays between the couple. */
      const siblings = ancestors ? renderInlineSiblings(coupleMember) : [];
      if (!siblings.length) return column;
      const fragment = document.createDocumentFragment();
      /* Partner on the left of the heart -> siblings go further left;
         partner on the right -> siblings go further right. The partner's
         own card must always be the one touching the heart. */
      const index = coupleMembers.indexOf(coupleMember);
      const hasSpouseAfter = index < coupleMembers.length - 1
        && isMarriedTo(coupleMember, coupleMembers[index + 1].id);
      if (hasSpouseAfter) {
        siblings.forEach((slot) => fragment.appendChild(slot));
        fragment.appendChild(column);
      } else {
        fragment.appendChild(column);
        siblings.forEach((slot) => fragment.appendChild(slot));
      }
      return fragment;
    });

    /* Tint each heart to match the stem and children of the same marriage.
       Applied after the cards exist, since appendCoupleCards() is what
       creates the hearts and stamps them with their marriage key. */
    if (showsChildren) {
      coupleRow.querySelectorAll('.couple-heart').forEach((heart) => {
        const tint = tintFor(heart.dataset.marriageKey);
        // Only marriages that actually have children are tinted; a childless
        // marriage has no stem or bus to be matched against.
        if (tint && childGroups.some((group) => group.key === heart.dataset.marriageKey)) {
          heart.classList.add(tint);
        }
      });
    }

    // The row is taller on the married-in side; flag it so the marriage line
    // and the heart align to the cards rather than to the stack above them.
    if (coupleMembers.some((person) => inlineAncestorFor.has(person.id))) {
      coupleRow.classList.add('has-inline-ancestors');
      // Lets extendIncomingDrops() find the card the incoming line must reach.
      coupleRow.dataset.bloodId = member.id;
    }

    wrapper.appendChild(coupleRow);
  }

  if (state.collapsed[member.id]) {
    return wrapper;
  }

  if (children.length) {
    const childrenWrap = document.createElement('div');
    childrenWrap.className = `children-row ${children.length === 1 ? 'single-child' : ''}`;

    /* Each marriage's children form one contiguous run, marked at its two
       ends so the sibling bus can be cut there. Without the cut, one bus
       would run across the whole row and join half-siblings as if they
       shared both parents. */
    childGroups.forEach((group) => {
      const tint = tintMap.get(group.key) || '';
      const rendered = [];

      const remote = [];
      group.children.forEach((child) => {
        /* Already drawn elsewhere (beside a spouse from another branch of
           the same tree). It must not be drawn twice, but the line from its
           own parents must still reach it: record it so the connector pass
           routes this marriage's bus to that existing card. */
        if (renderedMemberIds.has(child.id)) {
          remote.push(child.id);
          return;
        }
        const childBranch = renderFamilyGroup(child);
        childBranch.classList.add('child-branch');
        // A branch can come back empty under an active search filter, so the
        // group ends are marked from what actually rendered, not from the
        // data — otherwise the bus would be cut at an invisible child.
        if (!childBranch.childElementCount && !childBranch.textContent.trim()) return;
        if (tint) childBranch.classList.add(tint);
        childBranch.dataset.groupKey = group.key;
        rendered.push(childBranch);
        childrenWrap.appendChild(childBranch);
      });

      if (remote.length) {
        wrapper.querySelectorAll(':scope > .couple-row > .couple-stem').forEach((stem) => {
          if (stem.dataset.groupKey === group.key) stem.dataset.remoteIds = remote.join(',');
        });
      }

      if (!rendered.length) return;
      if (rendered.length === 1) {
        rendered[0].classList.add('group-solo');
      } else {
        rendered[0].classList.add('group-start');
        rendered[rendered.length - 1].classList.add('group-end');
      }
    });

    wrapper.appendChild(childrenWrap);
  }

  if (query && !wrapper.textContent.toLowerCase().includes(query)) {
    return document.createElement('div');
  }

  return wrapper;
}

function resetFormMode() {
  refs.form.removeAttribute('data-edit-id');
  // Cleared alongside the edit id: both encode "what this submit means", and
  // leaving one behind would attach the next unrelated member to a stale child.
  refs.form.removeAttribute('data-add-parent-for');
  refs.form.removeAttribute('data-add-parent-slot');
  refs.submitMemberBtn.textContent = 'Add Family Member';
  refs.cancelEditBtn.classList.add('hidden');
  refs.form.reset();
  syncSelectOptions();
}

function prepareQuickAddChildForm(memberId) {
  const member = getMemberById(memberId);
  if (!member) return;

  /* Which marriage the child belongs to is ambiguous once there are several,
     and guessing would silently attach the child to the wrong partner. Only
     an unambiguous single marriage is pre-filled; otherwise just the clicked
     member is set and the other parent is chosen explicitly in the form. */
  const spouses = getSpouses(member);
  const spouse = spouses.length === 1 ? spouses[0] : null;

  resetFormMode();
  refs.name.value = '';
  refs.sex.value = 'male';
  refs.age.value = '';
  refs.deceased.checked = false;
  setSelectedSpouseIds([]);
  // Route the clicked member and their spouse into the slot matching each
  // one's sex, so "Add Child" from a mother's card doesn't land her in Father.
  const anchors = [member, spouse && spouse.id !== member.id ? spouse : null].filter(Boolean);
  refs.father.value = anchors.find((person) => person.sex === 'male')?.id || '';
  refs.mother.value = anchors.find((person) => person.sex === 'female')?.id || '';

  // A parent with sex 'other' matches neither lookup; drop them into whichever
  // slot is still free rather than losing the relationship.
  anchors
    .filter((person) => person.sex !== 'male' && person.sex !== 'female')
    .forEach((person) => {
      if (!refs.father.value) refs.father.value = person.id;
      else if (!refs.mother.value) refs.mother.value = person.id;
    });
  refs.name.focus();
  refs.submitMemberBtn.textContent = 'Add Child';
}

/**
 * Primes the form to create a father or mother for an existing member.
 *
 * WHY A FORM FLAG RATHER THAN A FIELD: the form describes the person being
 * created, and its Father/Mother selects are that person's *own* parents.
 * There is no "children" control to drop the anchor into, so the link is
 * carried on the form as intent and resolved by addMember() once the new
 * member has an id.
 */
function prepareQuickAddParentForm(memberId, slot) {
  const member = getMemberById(memberId);
  if (!member) return;

  resetFormMode();
  refs.form.dataset.addParentFor = member.id;
  refs.form.dataset.addParentSlot = slot;

  refs.name.value = '';
  refs.sex.value = slot === 'father' ? 'male' : 'female';
  refs.age.value = '';
  refs.deceased.checked = false;

  // The opposite slot, if already filled, is this new parent's partner. Any
  // other reading would leave the couple row split across two branches.
  const { father, mother } = getParentsBySex(member);
  const partner = slot === 'father' ? mother : father;
  syncSelectOptions();
  setSelectedSpouseIds(partner ? [partner.id] : []);

  // Grandparent slots start empty — this flow adds one generation at a time.
  refs.father.value = '';
  refs.mother.value = '';

  refs.name.focus();
  refs.submitMemberBtn.textContent = slot === 'father' ? 'Add Father' : 'Add Mother';
}

/**
 * Primes the form to create a husband/wife for an existing member.
 *
 * WHY NO FORM FLAG (unlike Add Father/Mother): the parent flows need one
 * because the form has no control for "children", so the inverse link has to
 * be carried as intent. Spouse has no such gap — the form's own Spouse select
 * is exactly the relationship being created, and addMember() already links it
 * in both directions. Pre-selecting the anchor there reuses that path intact
 * rather than adding a second, parallel way to attach a partner.
 */
function prepareQuickAddSpouseForm(memberId) {
  const member = getMemberById(memberId);
  if (!member) return;

  resetFormMode();

  refs.name.value = '';
  // Default to the opposite sex as the common case; it stays editable, and
  // 'other' has no opposite so it is left on the form's own default.
  if (member.sex === 'male') refs.sex.value = 'female';
  else if (member.sex === 'female') refs.sex.value = 'male';
  refs.age.value = '';
  refs.deceased.checked = false;

  // Sync before assigning: the options must exist or nothing can be ticked.
  syncSelectOptions();
  setSelectedSpouseIds([member.id]);

  // A married-in partner brings their own parents, not the anchor's. Left
  // empty so the new member joins as a spouse only; Add Father/Mother on the
  // new card extends that side afterwards.
  refs.father.value = '';
  refs.mother.value = '';

  refs.name.focus();
  refs.submitMemberBtn.textContent = 'Add Spouse';
}

function populateFormForMember(memberId) {
  const member = getMemberById(memberId);
  if (!member) return;

  refs.form.dataset.editId = member.id;
  // Sync first: the father/mother lists are sex-filtered and exclude the
  // member being edited, so assigning a value before the options exist
  // would silently reset the select to "None".
  syncSelectOptions();
  refs.name.value = member.name;
  refs.sex.value = member.sex;
  // Age is optional, so an absent value must clear the input rather than
  // render "undefined" or leave the previous member's age behind.
  refs.age.value = member.age === '' || member.age === null || member.age === undefined
    ? ''
    : member.age;
  refs.deceased.checked = !!member.deceased;
  setSelectedSpouseIds(getSpouseIds(member));
  const { father, mother } = getParentsBySex(member);
  refs.father.value = father?.id || '';
  refs.mother.value = mother?.id || '';
  refs.submitMemberBtn.textContent = 'Update Family Member';
  refs.cancelEditBtn.classList.remove('hidden');
}

function removeMember(memberId) {
  const member = getMemberById(memberId);
  if (!member) return;

  state.members = state.members.filter((item) => item.id !== memberId);

  // Every surviving member is scrubbed of references, so ALL of the deleted
  // member's marriages are dropped, not just the first.
  state.members.forEach((item) => {
    item.spouseIds = getSpouseIds(item).filter((id) => id !== memberId);
    item.parentIds = item.parentIds.filter((id) => id !== memberId);
    item.childIds = item.childIds.filter((id) => id !== memberId);
  });

  if (member.parentIds.length) {
    member.parentIds.forEach((parentId) => {
      const parent = getMemberById(parentId);
      if (parent) {
        parent.childIds = parent.childIds.filter((id) => id !== memberId);
      }
    });
  }

  if (refs.form.dataset.editId === memberId) {
    resetFormMode();
  }

  syncSelectOptions();
  updateJsonOutput();
  updateTree();
  markDirty();
}

function addMember(event) {
  event.preventDefault();

  const name = refs.name.value.trim();
  const sex = refs.sex.value;
  const age = normalizeAge(refs.age.value);
  const deceased = refs.deceased.checked;
  const spouseIds = getSelectedSpouseIds();
  const fatherId = refs.father.value || '';
  const motherId = refs.mother.value || '';

  if (!name) {
    refs.name.focus();
    return;
  }

  // `type="number"` already blocks most junk, but a pasted or out-of-range
  // value still reaches us; reject it here instead of storing a bad age.
  if (age === INVALID_AGE) {
    refs.age.focus();
    refs.age.reportValidity();
    return;
  }

  // Sex filtering makes this reachable only via an 'other' parent, who is
  // offered in both lists; the same person can't fill both slots.
  if (fatherId && fatherId === motherId) {
    refs.mother.focus();
    return;
  }

  if (refs.form.dataset.editId) {
    const memberToUpdate = getMemberById(refs.form.dataset.editId);
    if (!memberToUpdate) {
      resetFormMode();
      return;
    }

    const oldParentIds = [...memberToUpdate.parentIds];

    memberToUpdate.name = name;
    memberToUpdate.sex = sex;
    memberToUpdate.age = age;
    memberToUpdate.deceased = deceased;
    // Father first by convention; getParentsBySex() resolves by sex, so the
    // order is presentational rather than load-bearing.
    memberToUpdate.parentIds = [fatherId, motherId].filter(Boolean);

    // Handles added and removed marriages in one step, keeping both sides of
    // every link in agreement.
    setSpouses(memberToUpdate.id, spouseIds);

    oldParentIds.forEach((parentId) => {
      if (!memberToUpdate.parentIds.includes(parentId)) {
        const parent = getMemberById(parentId);
        if (parent) {
          parent.childIds = parent.childIds.filter((childId) => childId !== memberToUpdate.id);
        }
      }
    });

    memberToUpdate.parentIds.forEach((parentId) => {
      if (parentId) {
        const parent = getMemberById(parentId);
        if (parent) {
          parent.childIds = [...new Set([...parent.childIds, memberToUpdate.id])];
        }
      }
    });

    linkCoParents();
    resetFormMode();
    syncSelectOptions();
    updateJsonOutput();
    updateTree();
    markDirty();
    closeDrawer();
    return;
  }

  const newMember = {
    id: `member-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    name,
    sex,
    age,
    deceased,
    spouseIds: [],
    parentIds: [fatherId, motherId].filter(Boolean),
    childIds: []
  };

  state.members.push(newMember);

  // Pushed first so linkSpouse() can resolve the new member by id.
  spouseIds.forEach((spouseId) => linkSpouse(newMember.id, spouseId));

  [fatherId, motherId].filter(Boolean).forEach((parentId) => {
    const parent = getMemberById(parentId);
    if (parent) parent.childIds = [...new Set([...parent.childIds, newMember.id])];
  });

  /* "Add Father/Mother" flow: the new member is a parent of the anchor, which
     is the inverse of every other path through this function. Linked here,
     after the id exists, and in both directions so the tree and the JSON agree.

     The new parent's spouse (the anchor's existing other parent) is deliberately
     NOT re-linked to the anchor — that relationship already exists. Only the
     anchor's own siblings would need the same treatment, and attaching them is
     a judgement call left to Edit rather than guessed at here. */
  const addParentFor = refs.form.dataset.addParentFor;
  if (addParentFor) {
    const anchor = getMemberById(addParentFor);
    if (anchor) {
      anchor.parentIds = [...new Set([...anchor.parentIds, newMember.id])];
      newMember.childIds = [...new Set([...newMember.childIds, anchor.id])];
    }
  }

  linkCoParents();
  resetFormMode();
  refs.form.reset();
  syncSelectOptions();
  updateJsonOutput();
  updateTree();
  markDirty();
  closeDrawer();
}

/**
 * Replaces `state.members` from a raw members array, applying the same
 * sanitising every entry point needs (textarea Apply, file import, server
 * load). Kept in one place so the three paths cannot drift apart.
 */
function adoptMembers(rawMembers) {
  state.members = rawMembers.map((member) => ({
    id: String(member.id || `member-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`),
    name: String(member.name || 'Unknown'),
    sex: ['male', 'female', 'other'].includes(member.sex) ? member.sex : 'other',
    age: sanitizeAge(member.age),
    deceased: sanitizeDeceased(member.deceased),
    spouseIds: sanitizeSpouseIds(member),
    parentIds: Array.isArray(member.parentIds) ? member.parentIds.map(String) : [],
    childIds: Array.isArray(member.childIds) ? member.childIds.map(String) : []
  }));
  reconcileSpouseLinks();
  linkCoParents();

  syncSelectOptions();
  updateJsonOutput();
  updateTree();
}

function applyJsonData() {
  const raw = refs.jsonOutput.value.trim();

  if (!raw) {
    return;
  }

  try {
    const parsed = JSON.parse(raw);

    if (!parsed || !Array.isArray(parsed.members)) {
      alert('JSON must have a members array.');
      return;
    }

    adoptMembers(parsed.members);
    markDirty();
  } catch (error) {
    alert('Invalid JSON format. Please check the structure and try again.');
  }
}

/* ------------------------------------------------------------------ */
/* Server persistence (see server.js)                                  */
/* ------------------------------------------------------------------ */

const SERVER_API = '/api/tree';

/**
 * Flags the tree as diverged from the server copy. Called by every mutation
 * path rather than from updateJsonOutput(), because that helper also runs on
 * first paint and right after a load — moments when nothing is actually
 * unsaved.
 */
function markDirty() {
  if (!state.dirty) {
    state.dirty = true;
    renderUnsavedBadge();
  }
  // Scheduled unconditionally: an edit arriving while already dirty must still
  // extend the debounce window, or it could be dropped from the pending write.
  scheduleAutosave();
}

/* --- Autosave ----------------------------------------------------- */

const AUTOSAVE_DELAY = 1000;

let autosaveTimer = null;
let autosaveInFlight = false;
let autosavePending = false;

/**
 * Coalesces a burst of edits into one write. Each mutation restarts the timer,
 * so a rapid sequence of adds produces a single request once things settle.
 */
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(runAutosave, AUTOSAVE_DELAY);
}

/**
 * Writes the current tree in the background. Serialised against itself: a save
 * triggered mid-flight sets a flag and runs afterwards, so the last edit always
 * reaches disk and two overlapping PUTs can never land out of order.
 */
async function runAutosave() {
  if (autosaveInFlight) {
    autosavePending = true;
    return;
  }

  if (!state.dirty) return;

  autosaveInFlight = true;
  // Captured before the await: edits during the request must stay dirty.
  const snapshot = state.members.length;
  setServerStatus('Saving…');

  try {
    const response = await fetch(`${SERVER_API}?autosave=1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ members: state.members })
    });

    if (!response.ok) {
      setServerStatus(`${await describeFailure(response)} — changes are unsaved.`, 'error');
      return;
    }

    const body = await response.json();

    // Only clear if nothing changed while the request was in flight; otherwise
    // the badge would go green over edits the server has not seen.
    if (!autosavePending && state.members.length === snapshot) {
      markClean();
    }

    setServerStatus(`Autosaved ${body.count} members at ${new Date(body.savedAt).toLocaleTimeString()}.`, 'ok');
  } catch (error) {
    setServerStatus('Could not reach the server — changes are unsaved.', 'error');
  } finally {
    autosaveInFlight = false;

    if (autosavePending) {
      autosavePending = false;
      scheduleAutosave();
    }
  }
}

/** Clears the flag once server and page agree again (save, load, or boot). */
function markClean() {
  if (!state.dirty) return;
  state.dirty = false;
  renderUnsavedBadge();
}

function renderUnsavedBadge() {
  if (!refs.unsavedBadge) return;
  refs.unsavedBadge.classList.toggle('hidden', !state.dirty);
}

function setServerStatus(message, tone = 'info') {
  if (!refs.serverStatus) return;
  refs.serverStatus.textContent = message;
  refs.serverStatus.dataset.tone = tone;
}

/** Pulls the server's error text out, falling back to the HTTP status. */
async function describeFailure(response) {
  try {
    const body = await response.json();
    if (body && body.error) return body.error;
  } catch (error) {
    /* Non-JSON error body — the status line is all we have. */
  }
  return `Request failed (${response.status})`;
}

async function saveToServer() {
  // Save what is actually rendered, not the textarea: the textarea may hold
  // unapplied edits, and persisting those would store a tree the user never
  // confirmed.
  setServerStatus('Saving…');
  refs.saveServerBtn.disabled = true;

  try {
    const response = await fetch(SERVER_API, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ members: state.members })
    });

    if (!response.ok) {
      setServerStatus(await describeFailure(response), 'error');
      return;
    }

    const body = await response.json();
    const time = new Date(body.savedAt).toLocaleTimeString();
    // Only on a confirmed 2xx: a failed save must leave the warning standing.
    markClean();
    setServerStatus(`Saved ${body.count} members to ${body.file} at ${time}.`, 'ok');
  } catch (error) {
    // fetch() only rejects on a transport failure, so this is almost always
    // "the server is not running".
    setServerStatus('Could not reach the server. Is `npm start` running?', 'error');
  } finally {
    refs.saveServerBtn.disabled = false;
  }
}

async function loadFromServer() {
  setServerStatus('Loading…');
  refs.loadServerBtn.disabled = true;

  try {
    const response = await fetch(SERVER_API);

    if (!response.ok) {
      setServerStatus(await describeFailure(response), 'error');
      return;
    }

    const body = await response.json();

    if (body.empty || !body.members.length) {
      // Adopting an empty array here would wipe the current tree in exchange
      // for nothing, so stop and say why.
      setServerStatus('No family data exists on the server yet.', 'error');
      return;
    }

    if (!confirm(`Replace the current tree with ${body.members.length} saved members?`)) {
      setServerStatus('Load cancelled.');
      return;
    }

    state.collapsed = {};
    resetFormMode();
    adoptMembers(body.members);
    // The page now mirrors the server exactly, so nothing is outstanding.
    markClean();
    setServerStatus(`Loaded ${body.members.length} members from the server.`, 'ok');
  } catch (error) {
    setServerStatus('Could not reach the server. Is `npm start` running?', 'error');
  } finally {
    refs.loadServerBtn.disabled = false;
  }
}

/**
 * First-paint load. The API is the only data source, so whatever this resolves
 * to IS the tree — there is no demo fallback. Unlike loadFromServer() it never
 * confirms (no user edits exist yet) and treats "nothing saved" as a normal
 * outcome rather than an error.
 *
 * Returns nothing; all outcomes are reported through the status line and the
 * empty-state canvas.
 */
async function bootstrapFromServer() {
  setTreeLoading(true);
  setEmptyStateView(EMPTY_STATE.LOADING);
  setServerStatus('Loading family data…');
  // Both server buttons would act on a tree that is about to be replaced.
  refs.loadServerBtn.disabled = true;
  refs.saveServerBtn.disabled = true;

  try {
    const response = await fetch(SERVER_API);

    if (!response.ok) {
      // Nothing to fall back to, so the canvas has to carry the explanation.
      setEmptyStateView(EMPTY_STATE.ERROR);
      setServerStatus(await describeFailure(response), 'error');
      return;
    }

    const body = await response.json();

    if (body.empty || !Array.isArray(body.members) || !body.members.length) {
      /* An empty array is a valid answer, not a failure: the server simply has
         no family data yet. Say so plainly and leave the canvas empty. */
      setEmptyStateView(EMPTY_STATE.NONE);
      setServerStatus('No family data exists on the server yet.');
      return;
    }

    setEmptyStateView(EMPTY_STATE.NONE);
    adoptMembers(body.members);
    // The page mirrors the server exactly at this point, so the badge must not
    // light up even though adoptMembers() re-rendered everything.
    markClean();
    setServerStatus(`Loaded ${body.members.length} members from the server.`, 'ok');
  } catch (error) {
    setEmptyStateView(EMPTY_STATE.ERROR);
    setServerStatus('Could not reach the server. Is `npm start` running?', 'error');
  } finally {
    setTreeLoading(false);
    refs.loadServerBtn.disabled = false;
    refs.saveServerBtn.disabled = false;
  }
}

/**
 * Dims the stage while a load is in flight. Applied to the stage rather than
 * the canvas so the placeholder is not wiped by the next updateTree().
 */
function setTreeLoading(isLoading) {
  if (!refs.treeRoot) return;
  refs.treeRoot.classList.toggle('is-loading', isLoading);
  refs.treeRoot.setAttribute('aria-busy', isLoading ? 'true' : 'false');
}

async function copyJson() {
  try {
    await navigator.clipboard.writeText(refs.jsonOutput.value);
    refs.copyJsonBtn.textContent = 'Copied';
    setTimeout(() => {
      refs.copyJsonBtn.textContent = 'Copy';
    }, 1200);
  } catch (error) {
    refs.copyJsonBtn.textContent = 'Copy failed';
    setTimeout(() => {
      refs.copyJsonBtn.textContent = 'Copy';
    }, 1200);
  }
}

function exportJsonFile() {
  const jsonText = refs.jsonOutput.value || JSON.stringify({ members: state.members }, null, 2);
  const blob = new Blob([jsonText], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'family-tree.json';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function importJsonFile(file) {
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const parsed = JSON.parse(event.target.result);
      if (!parsed || !Array.isArray(parsed.members)) {
        alert('JSON file must contain a members array.');
        return;
      }

      adoptMembers(parsed.members);
      markDirty();
      refs.jsonFileInput.value = '';
    } catch (error) {
      alert('Unable to parse this JSON file.');
    }
  };
  reader.readAsText(file);
}

/**
 * Empties the tree. With no bundled demo data there is nothing to "reset" to,
 * so this clears to the same empty state the API reports when it has no data.
 */
function clearAllData() {
  if (state.members.length && !confirm(`Remove all ${state.members.length} members from the page?`)) {
    return;
  }

  state.members = [];
  state.collapsed = {};
  setEmptyStateView(EMPTY_STATE.NONE);
  syncSelectOptions();
  updateJsonOutput();
  updateTree();
  /* Clearing throws away whatever was on screen; the server still holds the
     old tree, so this counts as unsaved until explicitly pushed. */
  markDirty();
}

function toggleCollapse(memberId, isCollapsed) {
  state.collapsed[memberId] = isCollapsed;
  updateTree();
}

/* ---------------------------------------------------------------
 * Zoom / pan for the tree area
 * ------------------------------------------------------------- */
/**
 * Zoom config mirrors the bfsiBuilder canvas (BFSI_BUILDER_JSON.ZOOM):
 * integer percentages, a coarse step for buttons/keyboard and a finer
 * per-tick step for the wheel so one trackpad swipe doesn't jump to the limit.
 */
const ZOOM = {
  MIN: 25,
  MAX: 400,
  STEP: 5,        // button / keyboard step
  WHEEL_STEP: 2   // per wheel-tick zoom delta (smoother)
};

// Canonical zoom state is the integer percentage, like the builder's
// domTarget._state.zoom. `zoomLevel` is the derived CSS scale factor.
let zoomPercent = 100;
let zoomLevel = 1;

/** Generic numeric clamp. */
function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

/** Clamps to the min/max range and snaps to a whole percent. */
function clampZoomPercent(value) {
  let z = Number(value);
  if (isNaN(z)) z = 100;
  z = Math.round(z);
  if (z < ZOOM.MIN) z = ZOOM.MIN;
  if (z > ZOOM.MAX) z = ZOOM.MAX;
  return z;
}

/**
 * Natural (un-scaled) size of the canvas. `transform` never affects layout,
 * so these values stay correct at any zoom level.
 */
function contentSize() {
  return {
    width: refs.treeCanvas.scrollWidth,
    height: refs.treeCanvas.scrollHeight
  };
}

/**
 * Centres the canvas whenever the scaled tree is smaller than the viewport.
 * Returns the applied offset so scroll math can account for it.
 */
function applyCentering() {
  const viewport = refs.treeRoot;
  // Re-reserve first: the scaled footprint drives how much scrollable room
  // exists, and that in turn decides whether any centring offset is needed.
  const { width, height } = reserveZoomScrollSpace();
  const offsetX = Math.max(0, (viewport.clientWidth - width * zoomLevel) / 2);
  const offsetY = Math.max(0, (viewport.clientHeight - height * zoomLevel) / 2);

  refs.treeCanvas.style.setProperty('--tree-offset-x', `${offsetX}px`);
  refs.treeCanvas.style.setProperty('--tree-offset-y', `${offsetY}px`);
  return { offsetX, offsetY };
}

/**
 * The scaled canvas must still be reachable by scrolling when zoomed past
 * 100%. `transform` never affects layout, so — exactly like the builder's
 * artboard wrap — a wrapper reserves the scaled footprint as real box size.
 */
function ensureCanvasWrap() {
  let wrap = refs.canvasWrap;
  if (wrap && wrap.parentNode === refs.treeRoot) return wrap;

  wrap = document.createElement('div');
  wrap.className = 'tree-canvas-wrap';
  refs.treeRoot.insertBefore(wrap, refs.treeCanvas);
  wrap.appendChild(refs.treeCanvas);
  refs.canvasWrap = wrap;
  return wrap;
}

function reserveZoomScrollSpace() {
  const wrap = ensureCanvasWrap();
  const { width, height } = contentSize();
  wrap.style.minWidth = `${Math.ceil(width * zoomLevel)}px`;
  wrap.style.minHeight = `${Math.ceil(height * zoomLevel)}px`;
  return { width, height };
}

function applyZoom() {
  zoomLevel = zoomPercent / 100;
  refs.treeCanvas.style.setProperty('--tree-zoom', zoomLevel);
  applyCentering(); // also re-reserves the scaled scroll footprint

  refs.zoomLevelLabel.textContent = `${zoomPercent}%`;
  refs.zoomInBtn.disabled = zoomPercent >= ZOOM.MAX;
  refs.zoomOutBtn.disabled = zoomPercent <= ZOOM.MIN;
}

/**
 * Sets the zoom, keeping the given viewport point visually anchored.
 * `origin` is optional; when omitted the viewport centre is used.
 */
function setZoom(next, origin) {
  const target = clampZoomPercent(next);
  if (target === zoomPercent) return;

  // Zoom moves every card on screen; a popover pinned to old coordinates
  // would detach from its trigger.
  closeFloat();

  const viewport = refs.treeRoot;
  const rect = viewport.getBoundingClientRect();

  // Anchor expressed in viewport-local CSS pixels. `clientWidth` excludes any
  // scrollbar, while `rect.width` includes it, so the anchor is derived from
  // the client box to stay in the same space as scrollLeft/scrollTop.
  const anchorX = origin
    ? clamp(origin.x - rect.left, 0, viewport.clientWidth)
    : viewport.clientWidth / 2;
  const anchorY = origin
    ? clamp(origin.y - rect.top, 0, viewport.clientHeight)
    : viewport.clientHeight / 2;

  // Canvas-space point currently sitting under the anchor. The centring
  // offset is part of the transform, so it must be removed before dividing
  // by the scale, and re-added afterwards in the new scale's offset.
  const before = applyCentering();
  const contentX = (viewport.scrollLeft + anchorX - before.offsetX) / zoomLevel;
  const contentY = (viewport.scrollTop + anchorY - before.offsetY) / zoomLevel;

  zoomPercent = target;
  // applyZoom -> applyCentering recomputes both the reserved scroll footprint
  // and the offset for the new scale, so `after` is the authoritative offset.
  applyZoom();
  const after = applyCentering();

  // Assigning scrollLeft/Top flushes layout first, so the enlarged wrap from
  // reserveZoomScrollSpace is already in effect and these values are not
  // silently clamped against the old, smaller scroll range.
  viewport.scrollLeft = contentX * zoomLevel + after.offsetX - anchorX;
  viewport.scrollTop = contentY * zoomLevel + after.offsetY - anchorY;
}

/** `delta` is in percent points, matching ZOOM.STEP / ZOOM.WHEEL_STEP. */
function zoomBy(delta, origin) {
  setZoom(zoomPercent + delta, origin);
}

/** Scrolls so the middle of the tree sits in the middle of the viewport. */
function centerView() {
  const viewport = refs.treeRoot;
  const { width, height } = contentSize();
  viewport.scrollLeft = Math.max(0, (width * zoomLevel - viewport.clientWidth) / 2);
  viewport.scrollTop = Math.max(0, (height * zoomLevel - viewport.clientHeight) / 2);
}

function resetZoom() {
  zoomPercent = 100;
  applyZoom();
  centerView();
}

/**
 * Fits the tree to the stage on both axes, like fitCanvasToScreen.
 * Measured at 100% because contentSize() reads the un-scaled layout only
 * once the current transform is neutral.
 */
function fitToScreen() {
  const branch = refs.treeCanvas.firstElementChild;
  if (!branch) return;

  const previous = zoomPercent;
  zoomPercent = 100;
  applyZoom();

  const { width: contentWidth, height: contentHeight } = contentSize();
  const available = refs.treeRoot.clientWidth - 24;
  const availableHeight = refs.treeRoot.clientHeight - 24;

  if (!contentWidth || available <= 0) {
    zoomPercent = previous;
    applyZoom();
    return;
  }

  // Height may legitimately be unmeasurable/zero; only constrain by it when
  // both values are usable, otherwise the ratio becomes NaN or Infinity.
  const ratios = [available / contentWidth];
  if (contentHeight > 0 && availableHeight > 0) {
    ratios.push(availableHeight / contentHeight);
  }

  zoomPercent = clampZoomPercent(Math.min(...ratios) * 100);
  applyZoom();
  centerView();
}

refs.zoomInBtn.addEventListener('click', () => zoomBy(ZOOM.STEP));
refs.zoomOutBtn.addEventListener('click', () => zoomBy(-ZOOM.STEP));
refs.zoomResetBtn.addEventListener('click', resetZoom);
refs.zoomFitBtn.addEventListener('click', fitToScreen);

// Ctrl/Cmd + wheel zooms around the pointer, like a canvas editor.
// Deltas are accumulated and flushed once per frame so a single trackpad
// swipe doesn't fly straight to the min/max (same approach as the builder).
let pendingZoomDelta = 0;
let zoomRaf = 0;
let zoomOrigin = null;

refs.treeRoot.addEventListener(
  'wheel',
  (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();

    // Normalise to +-1 per tick: line / page delta modes can otherwise
    // report very large deltaY values.
    const dir = event.deltaY < 0 ? 1 : -1;
    pendingZoomDelta += dir * ZOOM.WHEEL_STEP;
    zoomOrigin = { x: event.clientX, y: event.clientY };

    if (zoomRaf) return;
    zoomRaf = requestAnimationFrame(() => {
      const delta = pendingZoomDelta;
      const origin = zoomOrigin;
      pendingZoomDelta = 0;
      zoomRaf = 0;
      zoomOrigin = null;
      if (delta !== 0) zoomBy(delta, origin);
    });
  },
  { passive: false }
);

// Shift+1 fits the tree to the stage, matching the builder's Fit shortcut.
document.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || !event.shiftKey) return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (event.key === '!' || event.key === '1') {
    event.preventDefault();
    fitToScreen();
  }
});

// Keyboard: Ctrl/Cmd +, -, 0
document.addEventListener('keydown', (event) => {
  if (!event.ctrlKey && !event.metaKey) return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  if (event.key === '+' || event.key === '=') {
    event.preventDefault();
    zoomBy(ZOOM.STEP);
  } else if (event.key === '-' || event.key === '_') {
    event.preventDefault();
    zoomBy(-ZOOM.STEP);
  } else if (event.key === '0') {
    event.preventDefault();
    resetZoom();
  }
});

// Drag-to-pan on empty canvas space (ignores cards and buttons).
let panState = null;

refs.treeRoot.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  if (event.target.closest('button, input, select, textarea, .member-card, .branch-path')) return;

  panState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    scrollLeft: refs.treeRoot.scrollLeft,
    scrollTop: refs.treeRoot.scrollTop
  };
  refs.treeRoot.classList.add('is-panning');
  refs.treeRoot.setPointerCapture(event.pointerId);
});

refs.treeRoot.addEventListener('pointermove', (event) => {
  if (!panState || panState.pointerId !== event.pointerId) return;
  refs.treeRoot.scrollLeft = panState.scrollLeft - (event.clientX - panState.startX);
  refs.treeRoot.scrollTop = panState.scrollTop - (event.clientY - panState.startY);
});

function endPan(event) {
  if (!panState || panState.pointerId !== event.pointerId) return;
  refs.treeRoot.releasePointerCapture(event.pointerId);
  refs.treeRoot.classList.remove('is-panning');
  panState = null;
}

refs.treeRoot.addEventListener('pointerup', endPan);
refs.treeRoot.addEventListener('pointercancel', endPan);

// Viewport width changes alter how much offset is needed to centre.
window.addEventListener('resize', applyCentering);

applyZoom();

refs.form.addEventListener('submit', addMember);
refs.cancelEditBtn.addEventListener('click', () => {
  resetFormMode();
  closeDrawer();
});
refs.searchInput.addEventListener('input', () => updateTree());
refs.collapseAllBtn.addEventListener('click', () => {
  state.members.forEach((member) => {
    state.collapsed[member.id] = true;
  });
  updateTree();
});
refs.expandAllBtn.addEventListener('click', () => {
  state.members.forEach((member) => {
    state.collapsed[member.id] = false;
  });
  updateTree();
});
refs.applyJsonBtn.addEventListener('click', applyJsonData);
refs.copyJsonBtn.addEventListener('click', copyJson);
refs.exportJsonBtn.addEventListener('click', exportJsonFile);
refs.importJsonBtn.addEventListener('click', () => refs.jsonFileInput.click());
refs.jsonFileInput.addEventListener('change', (event) => importJsonFile(event.target.files[0]));
refs.saveServerBtn.addEventListener('click', saveToServer);
refs.loadServerBtn.addEventListener('click', loadFromServer);
refs.resetDataBtn.addEventListener('click', () => {
  resetFormMode();
  clearAllData();
});
/* The card triggers bind their own listeners (the popover/menu live outside
   .tree-root, so delegation from here could never reach them). The stage only
   needs to drop the floating layer when the anchor moves out from under it. */
refs.treeRoot.addEventListener('scroll', closeFloat, { passive: true });

/* Nothing can be dirty before the user has touched anything, and the initial
   empty page is not something the server is missing. Browsers also ignore preventDefault()
   here unless the page has been interacted with, so the guard keeps us from
   relying on a prompt that may never appear. */
window.addEventListener('beforeunload', (event) => {
  if (!state.dirty) return;
  event.preventDefault();
  // Legacy browsers need returnValue set; the text itself is always ignored.
  event.returnValue = '';
});

resetFormMode();
syncSelectOptions();
updateJsonOutput();
updateTree();
renderUnsavedBadge();

// The stage is flex-sized, so its final height is only known after the
// first layout pass. Re-centre once that has happened.
requestAnimationFrame(applyCentering);

/* The API is the sole data source. The page above painted an empty canvas in
   its "Loading…" state; this fills it in. Deliberately not awaited, so a slow
   or dead server cannot block first paint. */
bootstrapFromServer().then(() => {
  // The canvas just went from empty to a full tree, so re-centre.
  requestAnimationFrame(applyCentering);
});
