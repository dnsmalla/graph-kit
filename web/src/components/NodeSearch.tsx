import { useId, useMemo, useState, type KeyboardEvent, type Ref } from 'react';
import type { SystemGraph } from '../../../typescript/src/system/index.js';
import { searchCoreNodes, searchVizNodes, type NodeSearchHit } from '../orbit/search';
import type { VizGraph } from '../viz';

/**
 * The search results as a listbox. Keyboard focus stays in the input (aria-activedescendant),
 * so the list only shows and marks the active row; a click chooses a row.
 */
export function SearchResults({
  results,
  activeIndex,
  listId,
  optionId = (i) => `${listId}-${i}`,
  onChoose,
}: {
  results: NodeSearchHit[];
  activeIndex: number;
  listId: string;
  optionId?: (index: number) => string;
  onChoose: (hit: NodeSearchHit) => void;
}) {
  if (results.length === 0) {
    return (
      <p className="os-search-empty" role="status">
        No matching nodes.
      </p>
    );
  }
  return (
    <ul id={listId} role="listbox" aria-label="Matching nodes" className="os-search-results" onMouseDown={(e) => e.preventDefault()}>
      {results.map((hit, i) => (
        <li
          key={hit.id}
          id={optionId(i)}
          role="option"
          aria-selected={i === activeIndex}
          className={i === activeIndex ? 'os-search-option os-search-active' : 'os-search-option'}
          onClick={() => onChoose(hit)}
        >
          <span className="os-search-label">{hit.label}</span>
          <span className="os-search-meta">{hit.category}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Type-ahead over the nodes the brain draws: the project's core nodes, or the OS graph's nodes
 * when `viz` is given (label or id, case-insensitive, top matches). Arrow keys move through the
 * results, Enter chooses, Escape clears. Choosing calls `onChoose`; the caller flies the brain
 * to the node and selects it.
 */
export function NodeSearch({
  graph,
  viz = null,
  onChoose,
  inputRef,
}: {
  graph: SystemGraph | null;
  viz?: VizGraph | null;
  onChoose: (hit: NodeSearchHit) => void;
  /** The input, so the page can focus it with "/". */
  inputRef?: Ref<HTMLInputElement>;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (i: number) => `${baseId}-opt-${i}`;
  const results = useMemo(
    () => (viz ? searchVizNodes(viz, query) : searchCoreNodes(graph, query)),
    [graph, viz, query],
  );
  const showList = open && query.trim() !== '';
  // The listbox exists only when there are hits; the ARIA links point at it only then.
  const hasResults = showList && results.length > 0;
  const activeIndex = Math.min(active, Math.max(0, results.length - 1));
  const disabled = viz ? viz.nodes.length === 0 : !graph || graph.core.length === 0;

  const choose = (hit: NodeSearchHit) => {
    onChoose(hit);
    setQuery('');
    setOpen(false);
    setActive(0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive(Math.min(activeIndex + 1, Math.max(0, results.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(Math.max(activeIndex - 1, 0));
    } else if (e.key === 'Enter') {
      const hit = results[activeIndex];
      if (showList && hit) {
        e.preventDefault();
        choose(hit);
      }
    } else if (e.key === 'Escape') {
      setQuery('');
      setOpen(false);
    }
  };

  return (
    <div className="os-search" role="search">
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        className="os-search-input"
        aria-label="Search project nodes"
        aria-autocomplete="list"
        aria-expanded={hasResults}
        aria-controls={hasResults ? listId : undefined}
        aria-activedescendant={hasResults && results[activeIndex] ? optionId(activeIndex) : undefined}
        placeholder="Find a node…"
        disabled={disabled}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {showList ? (
        <SearchResults results={results} activeIndex={activeIndex} listId={listId} optionId={optionId} onChoose={choose} />
      ) : null}
    </div>
  );
}
