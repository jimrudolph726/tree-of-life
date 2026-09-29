import type { Journey, JourneyImage as JourneyImageData, JourneySummary } from './types.ts';

interface Props {
  view: 'library' | 'playing' | 'complete';
  step: number;
  journey: Journey | null;
  catalog: JourneySummary[];
  onSelect: (id: string) => void;
  onBegin: () => void;
  onStep: (step: number) => void;
  onPause: () => void;
  onClose: () => void;
  onLibrary: () => void;
  onComplete: () => void;
}

function JourneyImage({ image, priority = false }: { image: JourneyImageData; priority?: boolean }) {
  return <figure className="journey-image">
    <div><img src={`${import.meta.env.BASE_URL}${image.src}`} alt={image.alt} loading={priority ? 'eager' : 'lazy'} /></div>
    <figcaption><span>{image.caption}</span><a href={image.sourceUrl} target="_blank" rel="noreferrer">{image.credit} · {image.license} ↗</a></figcaption>
  </figure>;
}

export default function JourneyPanel({ view, step, journey, catalog, onSelect, onBegin, onStep,
  onPause, onClose, onLibrary, onComplete }: Props) {
  if (!journey) return <aside className="journey-panel journey-loading" aria-label="Loading journey">
    <button className="close-button" onClick={onClose} aria-label="Close journeys">×</button><div className="loading-indicator" />
  </aside>;

  if (view === 'library') return <aside className="journey-panel journey-library" aria-label="Evolutionary journeys">
    <button className="close-button" onClick={onClose} aria-label="Close journeys">×</button>
    <div className="journey-eyebrow">EVOLUTIONARY JOURNEY</div>
    <h1 className="journey-subject">{journey.category}</h1>
    <h2 className="journey-route">{journey.title}</h2>
    <p className="journey-lede">{journey.subtitle}</p>
    <article className="journey-card">
      <JourneyImage image={journey.steps[0].image} priority />
      <div className="journey-card-body">
        <div className="journey-meta"><span>{journey.steps.length} stops</span><span>{journey.duration}</span></div>
        <p className="journey-method">{journey.introduction}</p>
        <button className="journey-primary" onClick={onBegin}>Begin journey <span>→</span></button>
      </div>
    </article>
    <section className="journey-more"><h2>Journey library</h2><div className="journey-topic-grid">
      {catalog.filter(item => item.id !== journey.id).map(item => <button key={item.id} onClick={() => onSelect(item.id)}>
        <strong>{item.category}</strong><span>{item.title}</span><small>{item.stepCount} stops · {item.duration}</small>
      </button>)}
    </div></section>
  </aside>;

  if (view === 'complete') return <aside className="journey-panel journey-complete" aria-label="Journey complete">
    <button className="close-button" onClick={onClose} aria-label="Close journey">×</button>
    <div className="journey-finish-mark" aria-hidden="true">✓</div>
    <div className="journey-eyebrow">JOURNEY COMPLETE · {journey.category.toUpperCase()}</div>
    <h1>{journey.completion.title}</h1><p>{journey.completion.summary}</p>
    <button className="journey-primary" onClick={() => onStep(0)}>Restart journey</button>
    <button className="journey-secondary" onClick={onLibrary}>Browse all journeys</button>
    <button className="journey-text-button" onClick={onPause}>Explore this branch on the map</button>
  </aside>;

  const current = journey.steps[Math.min(step, journey.steps.length - 1)];
  return <aside className="journey-panel journey-player" aria-label="Evolutionary journey" aria-live="polite">
    <button className="close-button" onClick={onClose} aria-label="Close journey">×</button>
    <div className="journey-eyebrow">{journey.category.toUpperCase()} · {journey.title.toUpperCase()}</div>
    <div className="journey-progress" aria-label={`Step ${step + 1} of ${journey.steps.length}`}>
      {journey.steps.map((item, index) => <button key={item.title} aria-label={`Go to step ${index + 1}: ${item.title}`}
        aria-current={index === step ? 'step' : undefined} className={index < step ? 'visited' : ''} onClick={() => onStep(index)} />)}
    </div>
    <div className="journey-step-meta"><span>STEP {step + 1} OF {journey.steps.length}</span><span>{current.age}</span></div>
    <h1>{current.title}</h1>
    <div className="journey-taxon"><em>{current.taxon}</em><span>{current.kind}</span></div>
    {current.mapTaxon && <p className="journey-map-context">Map context: <em>{current.mapTaxon}</em>, a nearby evidence branch</p>}
    <JourneyImage image={current.image} priority />
    <p className="journey-summary">{current.summary}</p>
    <details className="journey-evidence"><summary>Evidence and uncertainty</summary><p>{current.evidence}</p><p className="journey-uncertainty">{current.uncertainty}</p>
      <div>{current.sources.map(source => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.label} ↗</a>)}</div></details>
    <button className="journey-explore" onClick={onPause}>Explore from here</button>
    <div className="journey-actions"><button onClick={() => onStep(step - 1)} disabled={step === 0}>← Back</button>
      <button className="journey-primary" onClick={() => step === journey.steps.length - 1 ? onComplete() : onStep(step + 1)}>
        {step === journey.steps.length - 1 ? 'Finish journey' : `Next: ${journey.steps[step + 1].title}`} <span>→</span></button></div>
  </aside>;
}
