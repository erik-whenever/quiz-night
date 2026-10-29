import { useEffect, useState } from "react";
import { TopBar } from "../App";
import { api, repoSets, uid } from "../lib/api";
import type { Question, QuestionMode, QuestionSet } from "../../shared/types";
import { MODE_LABEL, QUESTION_MODES, isCollectMode, validChoices } from "../../shared/types";
import PinGate from "./PinGate";

const blank = (): QuestionSet => ({ id: uid(), title: "", theme: "", source: "bank", updatedAt: "", questions: [] });

/** Rundtyp från JSON eller snabbinklistring: "alla" ger Alla svarar, "alt" ger Svarsalternativ, allt annat buzz (= utelämnat). */
function toMode(raw: unknown): QuestionMode | undefined {
  const m = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  const mode = m === "alla" || m === "alla svarar" ? "all"
    : m === "alt" || m === "alternativ" || m === "svarsalternativ" ? "choice" : (m as QuestionMode);
  return isCollectMode(mode) ? mode : undefined;
}

const splitChoices = (raw: string) => raw.split(";").map((x) => x.trim()).filter(Boolean);

/** "Fråga | Svar | poäng | alla" eller "Fråga | Svar | poäng | alt | A; B; C; D" per rad → frågor */
function parseQuick(text: string): Question[] {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const [t, a, p, m, ch] = l.split("|").map((x) => x.trim());
    const mode = toMode(m);
    return { id: uid(), text: t ?? "", answer: a ?? "", points: p ? Number(p) || 1 : undefined, mode,
      ...(mode === "choice" ? { choices: splitChoices(ch ?? "") } : {}) };
  }).filter((q) => q.text);
}

const modeNote = (s: QuestionSet) => {
  const parts = (["all", "choice"] as const)
    .map((m) => [m, s.questions.filter((q) => q.mode === m).length] as const)
    .filter(([, n]) => n > 0).map(([m, n]) => `${n} ${MODE_LABEL[m]}`);
  return parts.length ? ` · ${parts.join(", ")}` : "";
};

/** Första choice-fråga med ogiltiga alternativ, som felmeddelande. */
function choiceProblem(qs: Question[]): string {
  const i = qs.findIndex((q) => q.mode === "choice" && !validChoices(q));
  return i < 0 ? "" : `Fråga ${i + 1}: Svarsalternativ behöver 2–6 olika alternativ, och svaret måste stå exakt som ett av dem.`;
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
            <input className="a" aria-label={`Svar ${i + 1}`} value={q.answer} onChange={(e) => upd(i, { answer: e.target.value })} placeholder="Svar" />
            <input type="number" aria-label={`Poäng ${i + 1}`} min={1} value={q.points ?? 1} onChange={(e) => upd(i, { points: +e.target.value })} />
            <button className="btn sm ghost" aria-label={`Ta bort fråga ${i + 1}`} onClick={() => setS({ ...s, questions: s.questions.filter((_, j) => j !== i) })}>✕</button>
            <label className="mode">Rundtyp
              <select aria-label={`Rundtyp ${i + 1}`} value={q.mode ?? "buzz"} onChange={(e) => {
                const mode = toMode(e.target.value);
                upd(i, { mode, choices: mode === "choice" ? (q.choices?.length ? q.choices : q.answer.trim() ? [q.answer.trim()] : []) : undefined });
              }}>
                {QUESTION_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </label>
            {q.mode === "choice" && (
              <label className="choices">Alternativ (separera med ;)
                <input aria-label={`Alternativ ${i + 1}`} defaultValue={(q.choices ?? []).join("; ")} placeholder="Rätt svar; Fel 1; Fel 2; Fel 3"
                  onChange={(e) => upd(i, { choices: splitChoices(e.target.value) })} />
              </label>
            )}
          </div>
        ))}
        <button className="btn ghost" onClick={() => setS({ ...s, questions: [...s.questions, { id: uid(), text: "", answer: "" }] })}>Lägg till fråga</button>
      </div>

      <details>
        <summary className="muted">Klistra in många på en gång</summary>
        <div className="stack" style={{ marginTop: 12 }}>
          <p className="muted small">En fråga per rad: <code>Fråga | Svar | poäng | alla</code>. Poäng är valfritt, skriv <code>alla</code> sist för en Alla svarar-fråga,
            eller <code>Fråga | Svar | poäng | alt | Svar; Fel 1; Fel 2; Fel 3</code> för svarsalternativ i mobilen.</p>
          <textarea rows={6} value={quick} onChange={(e) => setQuick(e.target.value)} placeholder={"Vilket år kom HoN ut? | 2010\nVad heter Kungens hund? | …"} />
          <button className="btn" onClick={() => { setS({ ...s, questions: [...s.questions, ...parseQuick(quick)] }); setQuick(""); }} disabled={!quick.trim()}>Lägg till raderna</button>
        </div>
      </details>

      {err && <p className="err">{err}</p>}
      <div className="row">
        <button className="btn primary" disabled={!s.title.trim() || !s.questions.length} onClick={async () => {
          try {
            const clean = { ...s, questions: s.questions.filter((q) => q.text.trim() && q.answer.trim()) };
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
