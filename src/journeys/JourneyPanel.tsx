import { birdsFlight } from './birdsFlight.ts';
import type { JourneyImage as JourneyImageData } from './types.ts';

interface Props {
  view: 'library' | 'playing' | 'complete';
  step: number;
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

export default function JourneyPanel({ view, step, onBegin, onStep, onPause, onClose, onLibrary, onComplete }: Props) {
  if (view === 'library') return <aside className="journey-panel journey-library" aria-label="Evolutionary journeys">
    <button className="close-button" onClick={onClose} aria-label="Close journeys">×</button>
    <div className="journey-eyebrow">EVOLUTIONARY JOURNEY</div>
    <h1 className="journey-subject">Flight</h1>
    <h2 className="journey-route">{birdsFlight.title}</h2>
    <p className="journey-lede">{birdsFlight.subtitle}</p>
    <article className="journey-card">
      <JourneyImage image={birdsFlight.steps[0].image} priority />
      <div className="journey-card-body">
        <div className="journey-meta"><span>{birdsFlight.steps.length} stops</span><span>{birdsFlight.duration}</span></div>
        <p className="journey-method">{birdsFlight.introduction}</p>
        <button className="journey-primary" onClick={onBegin}>Begin journey <span>→</span></button>
      </div>
    </article>
    <section className="journey-coming"><h2>More journeys in development</h2><div className="journey-topic-grid">
      <div><strong>Vision</strong><span>From light-sensitive cells to vertebrate eyes</span></div>
      <div><strong>Bipedalism</strong><span>How walking on two legs evolved</span></div>
    </div></section>
  </aside>;

  if (view === 'complete') return <aside className="journey-panel journey-complete" aria-label="Journey complete">
    <button className="close-button" onClick={onClose} aria-label="Close journey">×</button>
    <div className="journey-finish-mark" aria-hidden="true">✓</div>
    <div className="journey-eyebrow">JOURNEY COMPLETE</div>
    <h1>A living dinosaur takes flight</h1>
    <p>You followed nine evidence points from feathers with non-flight roles to the integrated flight system of modern birds.</p>
    <button className="journey-primary" onClick={() => onStep(0)}>Restart journey</button>
    <button className="journey-secondary" onClick={onLibrary}>Browse all journeys</button>
    <button className="journey-text-button" onClick={onPause}>Explore modern birds on the map</button>
  </aside>;

  const current = birdsFlight.steps[step];
  return <aside className="journey-panel journey-player" aria-label="Evolutionary journey" aria-live="polite">
    <button className="close-button" onClick={onClose} aria-label="Close journey">×</button>
    <div className="journey-eyebrow">{birdsFlight.category.toUpperCase()} · {birdsFlight.title.toUpperCase()}</div>
    <div className="journey-progress" aria-label={`Step ${step + 1} of ${birdsFlight.steps.length}`}>
      {birdsFlight.steps.map((item, index) => <button key={item.title} aria-label={`Go to step ${index + 1}: ${item.title}`}
        aria-current={index === step ? 'step' : undefined} className={index < step ? 'visited' : ''} onClick={() => onStep(index)} />)}
    </div>
    <div className="journey-step-meta"><span>STEP {step + 1} OF {birdsFlight.steps.length}</span><span>{current.age}</span></div>
    <h1>{current.title}</h1>
    <div className="journey-taxon"><em>{current.taxon}</em><span>{current.kind}</span></div>
    {current.mapTaxon && <p className="journey-map-context">Map context: <em>{current.mapTaxon}</em>, a nearby evidence branch</p>}
    <JourneyImage image={current.image} priority />
    <p className="journey-summary">{current.summary}</p>
    <details className="journey-evidence"><summary>Evidence and uncertainty</summary><p>{current.evidence}</p><p className="journey-uncertainty">{current.uncertainty}</p>
      <div>{current.sources.map(source => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.label} ↗</a>)}</div></details>
    <button className="journey-explore" onClick={onPause}>Explore from here</button>
    <div className="journey-actions"><button onClick={() => onStep(step - 1)} disabled={step === 0}>← Back</button>
      <button className="journey-primary" onClick={() => step === birdsFlight.steps.length - 1 ? onComplete() : onStep(step + 1)}>
        {step === birdsFlight.steps.length - 1 ? 'Finish journey' : `Next: ${birdsFlight.steps[step + 1].title}`} <span>→</span></button></div>
  </aside>;
}
