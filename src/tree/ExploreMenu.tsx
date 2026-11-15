import { EXPLORE_SECTIONS, type ExploreDestination } from './explore.ts';

interface ExploreMenuProps {
  selectedOttId?: number | null;
  onHome: () => void;
  onSelect: (destination: ExploreDestination) => void;
}

export default function ExploreMenu({ selectedOttId, onHome, onSelect }: ExploreMenuProps) {
  return <div className="header-menu-popover explore-menu-popover" role="menu" aria-label="Explore the Tree of Life">
    <span>Explore the tree</span>
    <button className="explore-home" type="button" role="menuitem" onClick={onHome}>
      <span><strong>All Life</strong><small>Eukaryota, Archaea, and Bacteria</small></span><b aria-hidden="true">⌂</b>
    </button>
    {EXPLORE_SECTIONS.map(section => <div className="explore-section" role="group" aria-label={section.label} key={section.id}>
      <h3>{section.label}</h3>
      <div>{section.destinations.map(destination => <button type="button" role="menuitem"
        aria-current={selectedOttId === destination.ottId ? 'location' : undefined}
        key={destination.id} onClick={() => onSelect(destination)}>
        <span><strong>{destination.label}</strong><small>{destination.scientificName}</small></span>
        <b aria-hidden="true">{selectedOttId === destination.ottId ? '✓' : '→'}</b>
      </button>)}</div>
    </div>)}
  </div>;
}
