import type { ExtraStatus } from '../controller';
import type { OsSkill } from '../types';
import { fmtInt } from '../format';
import { Card, Empty } from './common';

/** The skills the host reports, as a deck of cards. The count sits in the header. */
export function SkillsDeck({ skills, status }: { skills: OsSkill[] | null; status: ExtraStatus }) {
  const count = skills ? fmtInt(skills.length) : null;
  return (
    <Card id="sec-skills" title="Skills" actions={count !== null ? <span className="meta">{count}</span> : null}>
      {skills !== null && skills.length > 0 ? (
        <ul className="skill-deck">
          {skills.map((skill) => (
            <li key={skill.id} className="skill-card">
              <div className="skill-head">
                <strong className="skill-name">{skill.name}</strong>
                {skill.source ? <span className="chip">{skill.source}</span> : null}
              </div>
              {skill.description ? <p className="skill-desc">{skill.description}</p> : null}
            </li>
          ))}
        </ul>
      ) : status === 'error' ? (
        <Empty>Could not load skills.</Empty>
      ) : status === 'none' ? (
        <Empty>Skills are not available in this host.</Empty>
      ) : status === 'ready' ? (
        <Empty>No skills yet. Skills you add to the project show up here.</Empty>
      ) : (
        <p className="meta" aria-live="polite">
          Loading skills…
        </p>
      )}
    </Card>
  );
}
