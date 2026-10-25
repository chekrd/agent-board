import type { Frozen } from '../deck.ts';
import type { Advice, QuestionOption } from '../types.ts';
import styles from './Options.module.css';
import parts from './Parts.module.css';
import { level } from './SecondOpinion.tsx';

// The second opinion's reply, its reasoning and how sure it is, with Edit to take it into the reply box.
function Suggestion({ advice, onEdit }: { advice: Advice; onEdit: () => void }) {
  return (
    <>
      <p className={styles.answer}>{advice.answer}</p>
      {advice.reasoning && <p className={styles.reasoning}>{advice.reasoning}</p>}
      <div className={styles.actions}>
        <button type="button" className={parts.tiny} title="Copy the suggestion into the reply box to change it first" onClick={onEdit}>
          Edit <kbd>E</kbd>
        </button>
        <span className={styles.level} title="How sure the second opinion is that you would decide the same">{level(advice.confidence)} confidence</span>
      </div>
    </>
  );
}

interface OptionsProps {
  options: readonly QuestionOption[];
  // A finished second opinion for this decision, whenever it finished.
  advice: Advice | null;
  frozen: Frozen | null;
  composing: boolean;
  // The standalone suggestion is what ⏎ already accepts, so it needs no button of its own.
  accepting: boolean;
  onPick: (label: string) => void;
  onAccept: () => void;
  onEdit: () => void;
}

// Each option sends itself when pressed. The frozen choice, what ⏎ sends, is highlighted; the second opinion shows on
// its own option, or as a block of its own when it picked none of them.
export function Options({ options, advice, frozen, composing, accepting, onPick, onAccept, onEdit }: OptionsProps) {
  const chosen = frozen && frozen.via !== 'menu' ? frozen.label : null;
  const apart = advice && !options.some((o) => o.label === advice.choice);
  return (
    <>
      {apart && (
        <div className={styles.standalone} data-frozen={(frozen?.via === 'advice' && frozen.label === null && frozen.adviceAt === advice.at) || undefined} data-suggestion>
          <div className={styles.standaloneHead}>
            <span className={parts.tag}>Second opinion · {advice.confidence}%</span>
            {!accepting && <button type="button" className={styles.accept} onClick={onAccept}>Accept suggestion</button>}
          </div>
          {!composing && <Suggestion advice={advice} onEdit={onEdit} />}
        </div>
      )}
      {options.length > 0 && (
        <div className={styles.options} role="group" aria-label="Options">
          {options.map((o, i) => {
            const suggested = advice?.choice === o.label;
            return (
              <div key={o.label} className={styles.option} data-frozen={o.label === chosen || undefined}>
                <button type="button" className={styles.button} data-option={i + 1} onClick={() => onPick(o.label)}>
                  <span className={styles.badge}>{i + 1}</span>
                  <span className={styles.text}>
                    <span className={styles.label}>{o.label}</span>
                    {o.description && <span className={styles.description}>{o.description}</span>}
                  </span>
                  <span className={styles.tags}>
                    {suggested && <span className={parts.tag}>Second opinion · {advice!.confidence}%</span>}
                    {o.recommended && <span className={parts.tag} data-quiet>Recommended</span>}
                  </span>
                </button>
                {suggested && !composing && (
                  <div className={styles.suggestion} data-suggestion>
                    <Suggestion advice={advice!} onEdit={onEdit} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
