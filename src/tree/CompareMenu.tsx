import { useEffect, useState } from 'react';
import type { ProfileClient } from '../profiles/client.ts';
import { discoverTaxa, type DiscoveryResult } from '../profiles/discovery.ts';
import type { TreeClient } from '../stream/client.ts';
import type { Summary } from '../stream/format.ts';

interface PickerProps {
  label: string;
  value?: Summary;
  client: TreeClient;
  profileClient: ProfileClient;
  onSelect: (node?: Summary) => void;
}

function TaxonPicker({ label, value, client, profileClient, onSelect }: PickerProps) {
  const [query, setQuery] = useState('');
  const [searchState, setSearchState] = useState<{ query: string; results: DiscoveryResult[] }>({ query: '', results: [] });
  const searching = Boolean(query.trim()) && query.trim() !== searchState.query;
  const results = searching ? [] : searchState.results;
  useEffect(() => {
    if (!query.trim() || value) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void discoverTaxa(client, profileClient, query, controller.signal, 'all', 6)
        .then(found => setSearchState({ query: query.trim(), results: found })).catch(() => undefined);
    }, 140);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [client, profileClient, query, value]);
  return <div className="compare-picker">
    <label>{label}</label>
    {value ? <div className="compare-choice"><span><strong>{value.scientificName}</strong>
      <small>{value.commonName ?? value.rank ?? (value.isTerminal ? 'Terminal taxon' : 'Clade')}</small></span>
      <button type="button" onClick={() => { onSelect(undefined); setQuery(''); }}>Change</button></div>
      : <><input aria-label={label} value={query} placeholder={`Search for the ${label.toLocaleLowerCase()}…`}
        onChange={event => setQuery(event.target.value)} autoComplete="off" />
        {query.trim() && <div className="compare-picker-results" role="listbox" aria-label={`${label} results`}>
          {results.length ? results.map(result => <button type="button" role="option" aria-selected="false" key={result.node.id}
            onPointerDown={event => event.preventDefault()} onClick={() => { onSelect(result.node); setQuery(''); }}>
            <span><strong>{result.node.scientificName}</strong>{result.commonName && <em>{result.commonName}</em>}</span>
            <small>{result.rank ?? (result.node.isTerminal ? 'Terminal taxon' : 'Clade')}</small>
          </button>) : <p role="status">{searching ? 'Searching…' : 'No matching taxa.'}</p>}
        </div>}</>}
  </div>;
}

export interface CompareMenuProps {
  client: TreeClient;
  profileClient: ProfileClient;
  current?: Summary | null;
  first?: Summary;
  second?: Summary;
  active: boolean;
  pending: boolean;
  linkNotice?: string | null;
  onFirst: (node?: Summary) => void;
  onSecond: (node?: Summary) => void;
  onCompare: () => void;
  onSwap: () => void;
  onCopy: () => void;
  onEnd: () => void;
}

export default function CompareMenu({ client, profileClient, current, first, second, active, pending, linkNotice,
  onFirst, onSecond, onCompare, onSwap, onCopy, onEnd }: CompareMenuProps) {
  const currentAvailable = current?.ottId && current.index !== first?.index && current.index !== second?.index;
  const canCompare = first && second && first.index !== second.index;
  return <div className="header-menu-popover compare-menu-popover" role="dialog" aria-label="Compare taxa">
    <span>Compare taxa</span>
    <p className="compare-menu-intro">Discover how two lineages are related.</p>
    {currentAvailable && <button className="compare-use-current" type="button" onClick={() => first ? onSecond(current) : onFirst(current)}>
      <small>Use current taxon</small><strong>{current.scientificName}</strong></button>}
    <TaxonPicker label="First taxon" value={first} client={client} profileClient={profileClient} onSelect={onFirst} />
    <TaxonPicker label="Second taxon" value={second} client={client} profileClient={profileClient} onSelect={onSecond} />
    <button className="compare-submit" type="button" disabled={!canCompare || pending} onClick={onCompare}>
      {pending ? 'Preparing comparison…' : active ? 'Update comparison' : 'Compare lineages'} <b aria-hidden="true">→</b></button>
    {(first || second) && <button className="compare-swap" type="button" disabled={!first || !second} onClick={onSwap}>Swap sides</button>}
    {active && <div className="compare-active-actions"><button type="button" onClick={onCopy}>Copy comparison link</button>
      <button type="button" onClick={onEnd}>End comparison</button></div>}
    {linkNotice && <p className="link-notice" role="status">{linkNotice}</p>}
  </div>;
}
