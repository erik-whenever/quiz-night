import { useEffect, useState } from "react";
import { TopBar } from "../App";
import { api, repoSets, uid } from "../lib/api";
import type { Question, QuestionMode, QuestionSet } from "../../shared/types";
import { MAX_POOL, QUESTION_MODES, validChoices } from "../../shared/types";
import { SKILLS, SKILL_KINDS, type OrderItem, type SkillKind, validSkill } from "../../shared/skill";
import PinGate from "./PinGate";

/** "Breaking Bad = 2008; Game of Thrones = 2011" ↔ saker att ordna */
const parseItems = (raw: string): OrderItem[] => raw.split(";").map((x) => x.trim()).filter(Boolean).map((x) => {
  const [label, v] = x.split("=").map((y) => y.trim());
  return { label: label ?? "", value: Number((v ?? "").replace(",", ".")) };
});
const itemsText = (items?: OrderItem[]) => (items ?? []).map((i) => `${i.label} = ${i.value}`).join("; ");

const blank = (): QuestionSet => ({ id: uid(), title: "", theme: "", source: "bank", updatedAt: "", questions: [] });

/** Rundtyp från JSON eller formuläret: "skill" ger skill-utmaning, allt annat svarsalternativ (= utelämnat). */
const toMode = (raw: unknown): QuestionMode | undefined => (raw === "skill" ? "skill" : undefined);

const splitList = (raw: string) => raw.split(";").map((x) => x.trim()).filter(Boolean);
/** Felalternativen = alla alternativ utom rätt svar. */
const wrongOf = (q: Question) => (q.choices ?? []).filter((c) => c.trim() !== q.answer.trim());
const withChoices = (answer: string, wrong: string[]) => [...new Set([answer.trim(), ...wrong].filter(Boolean))];

/** "Fråga | Svar | Fel 1; Fel 2; Fel 3 | poäng" per rad → frågor */
function parseQuick(text: string): Question[] {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const [t, a, wrong, p] = l.split("|").map((x) => x.trim());
    return { id: uid(), text: t ?? "", answer: a ?? "", choices: withChoices(a ?? "", splitList(wrong ?? "")), points: p ? Number(p) || 1 : undefined };
  }).filter((q) => q.text);
}

const playable = (q: Question) => (q.mode === "skill" ? !!validSkill(q.skill) : !!validChoices(q));
const modeNote = (s: QuestionSet) => {
  const skill = s.questions.filter((q) => q.mode === "skill").length;
  const bad = s.questions.filter((q) => !playable(q)).length;
  return `${skill ? ` · ${skill} skill` : ""}${bad ? ` · ${bad} saknar alternativ` : ""}`;
};

/** Första fråga som inte går att spela, som felmeddelande. */
function choiceProblem(qs: Question[]): string {
  const i = qs.findIndex((q) => q.mode !== "skill" && !validChoices(q));
  if (i >= 0) return `Fråga ${i + 1}: skriv minst ett felalternativ (gärna 7, så kan du köra upp till 8 alternativ). Högst ${MAX_POOL} alternativ totalt.`;
  const j = qs.findIndex((q) => q.mode === "skill" && !validSkill(q.skill));
  return j < 0 ? "" : `Fråga ${j + 1}: Ordna rätt behöver 3–6 saker med olika värden, t.ex. "Breaking Bad = 2008; Game of Thrones = 2011; How I Met Your Mother = 2005".`;
}

function Editor({ initial, onSaved, onCancel }: { initial: QuestionSet; onSaved: (s: QuestionSet) => void; onCancel: () => void }) {
  const [s, setS] = useState<QuestionSet>(initial);
  const [quick, setQuick] = useState("");
  const [err, setErr] = useState("");
  const upd = (i: number, patch: Partial<Question>) =>
    setS({ ...s, questions: s.questions.map((q, j) => (j === i ? { ...q, ...patch } : q)) });

  return (
    <section className="panel stack">
      <div className="spread"><h2>{initial.title ? "Redigera set" : "Nytt frågeset"}</h2><button className="btn ghost sm" onClick={onCancel}>Stäng</button></div>
      <div className="row" style={{ alignItems: "end" }}>
        <label style={{ flex: 2, minWidth: 220 }}>Titel<input value={s.title} onChange={(e) => setS({ ...s, title: e.target.value })} placeholder="Vecka 44: Blandat" /></label>
        <label style={{ flex: 1, minWidth: 160 }}>Tema<input value={s.theme ?? ""} onChange={(e) => setS({ ...s, theme: e.target.value })} placeholder="HoN, film, 90-tal…" /></label>
      </div>

      <div className="stack" style={{ gap: 8 }}>
        {s.questions.map((q, i) => (
          <div className="qrow" key={q.id}>
            <span className="n">{i + 1}</span>
            <textarea rows={1} aria-label={`Fråga ${i + 1}`} value={q.text} onChange={(e) => upd(i, { text: e.target.value })} placeholder="Fråga" />
            <input className="a" aria-label={`Svar ${i + 1}`} value={q.answer} disabled={q.mode === "skill"}
              onChange={(e) => upd(i, { answer: e.target.value, ...(q.mode !== "skill" ? { choices: withChoices(e.target.value, wrongOf(q)) } : {}) })}
              placeholder={q.mode === "skill" ? "–" : "Rätt svar"} />
            <select className="diff" aria-label={`Svårighet ${i + 1}`} value={q.difficulty ?? 3} disabled={q.mode === "skill"} title="Svårighet 1–5"
              onChange={(e) => upd(i, { difficulty: +e.target.value })}>
              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{"●".repeat(n)}</option>)}
            </select>
            <input type="number" aria-label={`Poäng ${i + 1}`} min={1} value={q.points ?? 1} onChange={(e) => upd(i, { points: +e.target.value })} />
            <button className="btn sm ghost" aria-label={`Ta bort fråga ${i + 1}`} onClick={() => setS({ ...s, questions: s.questions.filter((_, j) => j !== i) })}>✕</button>
            <label className="mode">Rundtyp
              <select aria-label={`Rundtyp ${i + 1}`} value={q.mode ?? "choice"} onChange={(e) => {
                const mode = toMode(e.target.value);
                upd(i, { mode, skill: mode === "skill" ? (q.skill ?? { kind: "lasthit" }) : undefined });
              }}>
                {QUESTION_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </label>
            {q.mode === "skill" && (
              <div className="choices row" style={{ alignItems: "end" }}>
                <label style={{ flex: "0 0 auto" }}>Utmaning
                  <select aria-label={`Utmaning ${i + 1}`} value={q.skill?.kind ?? "lasthit"}
                    onChange={(e) => upd(i, { skill: { ...q.skill, kind: e.target.value as SkillKind } })}>
                    {SKILL_KINDS.map((k) => <option key={k} value={k}>{SKILLS[k].name}</option>)}
                  </select>
                </label>
                {q.skill?.kind === "stopwatch" && (
                  <label style={{ flex: "0 0 120px" }}>Mål (s)
                    <input type="number" min={3} max={30} step={0.5} aria-label={`Mål ${i + 1}`} value={q.skill.target ?? 10}
                      onChange={(e) => upd(i, { skill: { ...q.skill!, target: +e.target.value } })} />
                  </label>
                )}
                {q.skill?.kind === "order" && (
                  <>
                    <label style={{ flex: "0 0 160px" }}>Ordning
                      <input aria-label={`Ordning ${i + 1}`} value={q.skill.prompt ?? ""} placeholder="Äldst först"
                        onChange={(e) => upd(i, { skill: { ...q.skill!, prompt: e.target.value } })} />
                    </label>
                    <label style={{ flex: 1, minWidth: 220 }}>Saker (namn = värde; …)
                      <input aria-label={`Saker ${i + 1}`} defaultValue={itemsText(q.skill.items)} placeholder="Breaking Bad = 2008; Game of Thrones = 2011"
                        onChange={(e) => upd(i, { skill: { ...q.skill!, items: parseItems(e.target.value) } })} />
                    </label>
                  </>
                )}
              </div>
            )}
            {q.mode !== "skill" && (
              <label className="choices">Felalternativ (separera med ;)
                <input aria-label={`Felalternativ ${i + 1}`} defaultValue={wrongOf(q).join("; ")} placeholder="Fel 1; Fel 2; Fel 3 … gärna 7 st"
                  onChange={(e) => upd(i, { choices: withChoices(q.answer, splitList(e.target.value)) })} />
              </label>
            )}
          </div>
        ))}
        <button className="btn ghost" onClick={() => setS({ ...s, questions: [...s.questions, { id: uid(), text: "", answer: "", choices: [] }] })}>Lägg till fråga</button>
      </div>

      <details>
        <summary className="muted">Klistra in många på en gång</summary>
        <div className="stack" style={{ marginTop: 12 }}>
          <p className="muted small">En fråga per rad: <code>Fråga | Rätt svar | Fel 1; Fel 2; Fel 3 | poäng</code>. Poäng är valfritt.
            Skriv gärna 7 felalternativ, så kan du välja upp till 8 alternativ på kvällen.</p>
          <textarea rows={6} value={quick} onChange={(e) => setQuick(e.target.value)} placeholder={"Vilket år kom HoN ut? | 2010 | 2008; 2009; 2011; 2012\nVilken krydda är dyrast? | Saffran | Vanilj; Kardemumma; Svartpeppar"} />
          <button className="btn" onClick={() => { setS({ ...s, questions: [...s.questions, ...parseQuick(quick)] }); setQuick(""); }} disabled={!quick.trim()}>Lägg till raderna</button>
        </div>
      </details>

      {err && <p className="err">{err}</p>}
      <div className="row">
        <button className="btn primary" disabled={!s.title.trim() || !s.questions.length} onClick={async () => {
          try {
            const clean = { ...s, questions: s.questions.filter((q) => q.text.trim() && (q.answer.trim() || q.mode === "skill"))
              .map((q) => (q.mode === "skill" ? { ...q, choices: undefined } : { ...q, mode: undefined, choices: withChoices(q.answer, wrongOf(q)) })) };
            const problem = choiceProblem(clean.questions);
            if (problem) return setErr(problem);
            onSaved(await api.saveSet(clean));
          } catch (e) { setErr((e as Error).message); }
        }}>Spara set</button>
        <button className="btn ghost" onClick={() => {
          const blob = new Blob([JSON.stringify({ ...s, source: undefined }, null, 2)], { type: "application/json" });
          const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${s.title || "quiz"}.json`; a.click();
        }}>Ladda ner som JSON</button>
      </div>
    </section>
  );
}

function BankPage() {
  const [bank, setBank] = useState<QuestionSet[]>([]);
  const [editing, setEditing] = useState<QuestionSet | null>(null);
  const [err, setErr] = useState("");
  const load = () => api.bankSets().then(setBank).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const importJson = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      setEditing({ ...blank(), ...data, id: uid(), source: "bank", questions: (data.questions ?? []).map((q: Question) => ({ ...q, id: q.id ?? uid(), mode: toMode(q.mode) })) });
    } catch { setErr("Kunde inte läsa filen. Är det giltig JSON?"); }
  };

  return (
    <>
      <TopBar host />
      <main className="wrap stack" style={{ gap: 24 }}>
        <div className="spread">
          <h1>Frågebank</h1>
          <div className="row">
            <label className="btn ghost" style={{ flexDirection: "row" }}>Importera JSON
              <input type="file" accept="application/json" hidden onChange={(e) => e.target.files?.[0] && importJson(e.target.files[0])} />
            </label>
            <button className="btn primary" onClick={() => setEditing(blank())}>Nytt set</button>
          </div>
        </div>
        {err && <p className="err">{err}</p>}
        {editing && <Editor key={editing.id} initial={editing} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}

        <section className="stack">
          <h3>Dina set</h3>
          {bank.length === 0 && <p className="muted">Inga egna set än. Skapa ett eller kopiera ett från rådet nedan.</p>}
          {bank.map((s) => (
            <div key={s.id} className="panel flat spread" style={{ padding: 14 }}>
              <span><strong>{s.title}</strong> <span className="muted small">· {s.questions.length} frågor{modeNote(s)}{s.theme ? ` · ${s.theme}` : ""}</span></span>
              <span className="row">
                <button className="btn sm" onClick={() => setEditing(s)}>Redigera</button>
                <button className="btn sm ghost" onClick={async () => { if (confirm(`Radera ${s.title}?`)) { await api.deleteSet(s.id); load(); } }}>Radera</button>
              </span>
            </div>
          ))}
        </section>

        <section className="stack">
          <h3>Från AI-rådet</h3>
          <p className="muted small">Quizresearchern checkar in färdiga set i repot. Kopiera ett för att ändra i det.</p>
          {repoSets.map((s) => (
            <div key={s.id} className="panel flat spread" style={{ padding: 14 }}>
              <span><strong>{s.title}</strong> <span className="muted small">· {s.questions.length} frågor{modeNote(s)}{s.theme ? ` · ${s.theme}` : ""}</span></span>
              <button className="btn sm" onClick={() => setEditing({ ...s, id: uid(), title: s.title + " (kopia)", source: "bank" })}>Kopiera och redigera</button>
            </div>
          ))}
        </section>
      </main>
    </>
  );
}

export default function Bank() {
  return <PinGate><BankPage /></PinGate>;
}
