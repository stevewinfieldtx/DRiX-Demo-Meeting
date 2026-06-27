import { useState, useCallback } from "react";

const C = {
  navy: "#0F1B2D", deep: "#1A3A5C", teal: "#0EA5E9", cyan: "#22D3EE",
  white: "#FFFFFF", off: "#F0F4F8", mgray: "#94A3B8",
  dark: "#1E293B", body: "#334155", amber: "#F59E0B", green: "#10B981", red: "#EF4444",
};

const BRAIN_URL = "https://drix-brain.up.railway.app";

const PERSONAS = [
  { id: "economic", label: "Economic Buyer", ex: "CFO, VP Finance, COO", color: C.amber, icon: "\u{1F4B0}" },
  { id: "technical", label: "Technical Evaluator", ex: "CISO, CTO, IT Director", color: C.teal, icon: "\u{1F527}" },
  { id: "champion", label: "Business Champion", ex: "VP of IT, LOB Leader", color: C.green, icon: "\u{1F3AF}" },
];

const Pill = ({ color, children }) => (
  <span style={{ padding: "2px 9px", borderRadius: 10, background: `${color}18`, color, fontSize: 10, fontWeight: 600 }}>{children}</span>
);

export default function App() {
  const [customer, setCustomer] = useState("");
  const [solution, setSolution] = useState("");
  const [selected, setSelected] = useState([]);
  const [tdeOn, setTdeOn] = useState(false);
  const [stage, setStage] = useState("first");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [dragIdx, setDragIdx] = useState(null);
  const [loadMsg, setLoadMsg] = useState("");

  // Attendee detail inputs (for TDE mode)
  const [attendeeDetails, setAttendeeDetails] = useState({});
  const updateDetail = (personaId, field, val) => {
    setAttendeeDetails(p => ({ ...p, [personaId]: { ...(p[personaId] || {}), [field]: val } }));
    setResult(null);
  };

  const toggle = (id) => { setSelected(p => p.includes(id) ? p.filter(x => x !== id) : p.length >= 3 ? p : [...p, id]); setResult(null); };
  const move = (from, to) => { setSelected(p => { const n = [...p]; const [m] = n.splice(from, 1); n.splice(to, 0, m); return n; }); setResult(null); };
  const comboLabel = () => selected.length === 0 ? "No attendees" : selected.map(id => PERSONAS.find(p => p.id === id)?.label).join(" + ");
  const stageLabel = stage === "first" ? "1st Meeting" : "Final Decision";
  const pColor = (label) => {
    if (!label) return C.mgray;
    const l = label.toLowerCase();
    return l.includes("economic") || l.includes("cfo") || l.includes("finance") ? C.amber
      : l.includes("technical") || l.includes("ciso") || l.includes("cto") || l.includes("it dir") ? C.teal
      : l.includes("champion") || l.includes("business") || l.includes("vp") ? C.green : C.mgray;
  };

  // ── GENERATE: TDE OFF = Claude prompt, TDE ON = Brain API ──
  const generate = useCallback(async () => {
    if (!customer || !solution || selected.length === 0) return;
    setLoading(true); setErr(null); setResult(null);

    if (tdeOn) {
      // ━━━ TDE MODE: Call DRiX Brain ━━━
      setLoadMsg("Connecting to DRiX Brain...");
      try {
        const attendees = selected.map(id => {
          const p = PERSONAS.find(x => x.id === id);
          const d = attendeeDetails[id] || {};
          return {
            name: d.name || p.label,
            title: d.title || p.ex.split(",")[0].trim(),
            company: customer,
            email: d.email || null,
            linkedin: d.linkedin || null,
            company_url: d.companyUrl || null,
          };
        });

        setLoadMsg("Running individual scans (" + attendees.length + " attendees)...");

        const res = await fetch(BRAIN_URL + "/intel/meeting", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            attendees,
            solution,
            meetingType: stage === "first" ? "discovery" : "negotiation",
            company: customer,
            notes: `Meeting stage: ${stageLabel}. Attendee priority order: ${selected.map((id, i) => `#${i+1} ${PERSONAS.find(x => x.id === id)?.label}`).join(", ")}`,
          }),
        });

        if (!res.ok) {
          const errBody = await res.text();
          throw new Error(`Brain ${res.status}: ${errBody.slice(0, 300)}`);
        }

        setLoadMsg("Processing intelligence...");
        const data = await res.json();
        setResult({ type: "brain", data, cached: data._cached });

      } catch (e) {
        setErr(`Brain error: ${e.message}`);
        console.error("Brain error:", e);
      }
    } else {
      // ━━━ GENERIC MODE: Claude prompt ━━━
      setLoadMsg("Generating outline...");
      const personas = selected.map((id, i) => {
        const p = PERSONAS.find(x => x.id === id);
        return `${i + 1}. ${p.label} (${p.ex}) — Priority #${i + 1}`;
      }).join("\n");

      const prompt = `You are a B2B meeting intelligence system. Generate a meeting outline.
CUSTOMER: ${customer}
SOLUTION: ${solution}
STAGE: ${stage === "first" ? "FIRST MEETING — Discovery, qualify, earn the next meeting." : "FINAL DECISION — Close, handle objections, secure commitment."}
ATTENDEES (by importance):
${personas}

Generate a 5-7 section meeting outline as JSON: { "title": "...", "sections": [{ "heading": "Section", "targetPersona": "who", "subs": [{ "point": "Sub-point", "details": ["Detail 1"] }] }] }

Be specific to this customer and solution. Return ONLY valid JSON.`;

      try {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 4096, messages: [{ role: "user", content: prompt }] }),
        });
        if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const d = await res.json();
        if (d.error) throw new Error(d.error.message);
        const txt = d.content?.map(b => b.type === "text" ? b.text : "").join("");
        const parsed = JSON.parse(txt.replace(/```json|```/g, "").trim());
        setResult({ type: "generic", data: parsed });
      } catch (e) { setErr(e.message); }
    }
    setLoading(false);
  }, [customer, solution, selected, stage, tdeOn, attendeeDetails]);

  // ── RENDER: Brain result vs Generic outline ──
  const renderResult = () => {
    if (!result) return null;

    if (result.type === "brain") {
      const d = result.data;
      const synth = d.solutionIntersection;
      const group = d.groupDynamics;
      return (
        <div style={{ background: C.white, borderRadius: "0 0 10px 10px", padding: "20px 24px" }}>
          {/* Executive Summary */}
          {synth?.executiveSummary && (
            <div style={{ background: C.off, borderRadius: 10, padding: "14px 18px", borderLeft: `4px solid ${C.cyan}`, marginBottom: 16 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.cyan, textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>Executive Summary</div>
              <div style={{ fontSize: 14, color: C.dark, lineHeight: 1.5 }}>{synth.executiveSummary}</div>
            </div>
          )}

          {/* Power Map */}
          {group?.powerMap && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.navy, marginBottom: 8 }}>Power Map</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {group.powerMap.decisionMaker && <Pill color={C.amber}>Decision: {group.powerMap.decisionMaker}</Pill>}
                {group.powerMap.champions?.map((c, i) => <Pill key={i} color={C.green}>Champion: {c}</Pill>)}
                {group.powerMap.blockers?.map((b, i) => <Pill key={i} color={C.red}>Blocker: {b}</Pill>)}
                {group.powerMap.influencers?.map((inf, i) => <Pill key={i} color={C.teal}>Influencer: {inf}</Pill>)}
              </div>
            </div>
          )}

          {/* Per-person strategy */}
          {synth?.solutionIntersection?.perPerson?.map((pp, i) => (
            <div key={i} style={{ background: C.off, borderRadius: 10, padding: "14px 18px", borderLeft: `4px solid ${pColor(pp.name)}`, marginBottom: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.dark, marginBottom: 4 }}>{pp.name}</div>
              <div style={{ fontSize: 12, color: C.body, marginBottom: 6 }}>{pp.messagingAngle}</div>
              {pp.relevantPainPoints?.length > 0 && (
                <div style={{ marginBottom: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 600, color: C.red }}>Pain: </span>
                  <span style={{ fontSize: 11, color: C.body }}>{pp.relevantPainPoints.join(" · ")}</span>
                </div>
              )}
              {pp.objections?.slice(0, 2).map((obj, j) => (
                <div key={j} style={{ fontSize: 11, color: C.body, marginBottom: 3 }}>
                  <span style={{ fontWeight: 600 }}>Objection: </span>{obj.objection}
                  <br/><span style={{ color: C.green, fontWeight: 600 }}>→ </span>{obj.response}
                </div>
              ))}
            </div>
          ))}

          {/* Meeting Script */}
          {synth?.meetingScript && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.navy, marginBottom: 8 }}>Meeting Flow</div>
              {synth.meetingScript.opening && (
                <div style={{ fontSize: 12, color: C.body, marginBottom: 8, paddingLeft: 12, borderLeft: `3px solid ${C.green}30` }}>
                  <span style={{ fontWeight: 600, color: C.green }}>Open: </span>{synth.meetingScript.opening}
                </div>
              )}
              {synth.meetingScript.assignments?.map((a, i) => (
                <div key={i} style={{ fontSize: 12, color: C.body, marginBottom: 6, paddingLeft: 12, borderLeft: `3px solid ${C.teal}30` }}>
                  <span style={{ fontWeight: 600 }}>{a.topic}</span> → {a.directedAt}
                  <div style={{ fontSize: 10, color: C.mgray }}>{a.why}</div>
                </div>
              ))}
              {synth.meetingScript.closingMove && (
                <div style={{ fontSize: 12, color: C.body, paddingLeft: 12, borderLeft: `3px solid ${C.amber}30` }}>
                  <span style={{ fontWeight: 600, color: C.amber }}>Close: </span>{synth.meetingScript.closingMove}
                </div>
              )}
            </div>
          )}

          {/* Room energy + win condition */}
          {(group?.roomEnergy || group?.winCondition) && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 14 }}>
              {group.roomEnergy && (
                <div style={{ background: C.off, borderRadius: 8, padding: "10px 14px", borderLeft: `4px solid ${C.amber}` }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: C.amber, textTransform: "uppercase", marginBottom: 3 }}>Room Energy</div>
                  <div style={{ fontSize: 12, color: C.body }}>{group.roomEnergy}</div>
                </div>
              )}
              {group.winCondition && (
                <div style={{ background: C.off, borderRadius: 8, padding: "10px 14px", borderLeft: `4px solid ${C.green}` }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: C.green, textTransform: "uppercase", marginBottom: 3 }}>Win Condition</div>
                  <div style={{ fontSize: 12, color: C.body }}>{group.winCondition}</div>
                </div>
              )}
            </div>
          )}

          {/* Deal killers */}
          {synth?.dealKillers?.length > 0 && (
            <div style={{ background: "#FEF2F2", borderRadius: 8, padding: "10px 14px", borderLeft: `4px solid ${C.red}`, marginTop: 12 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.red, textTransform: "uppercase", marginBottom: 4 }}>Deal Killers</div>
              {synth.dealKillers.map((dk, i) => <div key={i} style={{ fontSize: 11, color: C.body, marginBottom: 2 }}>· {dk}</div>)}
            </div>
          )}

          {/* Pipeline time + cache status */}
          <div style={{ display: "flex", gap: 8, marginTop: 14, justifyContent: "flex-end" }}>
            {d.pipelineTimeMs && <Pill color={C.mgray}>{(d.pipelineTimeMs / 1000).toFixed(1)}s pipeline</Pill>}
            {d.totalAtoms && <Pill color={C.cyan}>{d.totalAtoms} TDE atoms</Pill>}
            <Pill color={result.cached ? C.green : C.teal}>{result.cached ? "Cached" : "Live scan"}</Pill>
          </div>
        </div>
      );
    }

    // Generic outline render
    const outline = result.data;
    return (
      <div style={{ background: C.white, borderRadius: "0 0 10px 10px", padding: "20px 24px" }}>
        {outline.sections?.map((sec, i) => (
          <div key={i} style={{ marginBottom: i < outline.sections.length - 1 ? 16 : 0 }}>
            <div style={{ display: "flex", gap: 10, marginBottom: 6 }}>
              <div style={{ minWidth: 28, height: 28, borderRadius: 6, background: C.navy, color: C.cyan, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 12, flexShrink: 0 }}>
                {["I","II","III","IV","V","VI","VII"][i] || (i+1)}
              </div>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.dark }}>{sec.heading?.replace(/^[IVX]+\.\s*/, "")}</div>
                {sec.targetPersona && <span style={{ fontSize: 10, color: pColor(sec.targetPersona), fontWeight: 600 }}>→ {sec.targetPersona}</span>}
              </div>
            </div>
            <div style={{ marginLeft: 38 }}>
              {sec.subs?.map((sub, j) => (
                <div key={j} style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: C.dark, borderLeft: `3px solid ${pColor(sec.targetPersona)}30`, paddingLeft: 10, marginBottom: 2 }}>
                    {sub.point?.replace(/^[A-C]\.\s*/, "")}
                  </div>
                  {sub.details?.map((det, k) => (
                    <div key={k} style={{ fontSize: 11, color: C.body, paddingLeft: 22, position: "relative", marginBottom: 1 }}>
                      <span style={{ position: "absolute", left: 10, color: C.mgray }}>·</span>
                      {det.replace(/^\d+\.\s*/, "")}
                    </div>
                  ))}
                </div>
              ))}
            </div>
            {i < outline.sections.length - 1 && <div style={{ height: 1, background: "#E2E8F0", marginTop: 6 }}/>}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div style={{ minHeight: "100vh", background: C.navy, fontFamily: '-apple-system, "Segoe UI", system-ui, sans-serif', color: C.white }}>
      {/* Header */}
      <div style={{ padding: "14px 24px", borderBottom: `1px solid ${C.deep}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontSize: 20, fontWeight: 800 }}>
          DR<span style={{ color: C.cyan, fontStyle: "italic" }}>i</span>X
          <span style={{ color: C.mgray, fontWeight: 400, fontSize: 13, marginLeft: 10 }}>Meeting Intelligence</span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ display: "flex", borderRadius: 6, overflow: "hidden", border: `1px solid ${C.deep}` }}>
            {[["first", "1st Meeting"], ["final", "Final Decision"]].map(([v, l]) => (
              <button key={v} onClick={() => { setStage(v); setResult(null); }}
                style={{ padding: "6px 14px", border: "none", background: stage === v ? (v === "first" ? C.teal : C.amber) : C.deep, color: stage === v ? C.white : C.mgray, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
                {l}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 4 }}>
            <span style={{ fontSize: 10, color: tdeOn ? C.cyan : C.mgray, fontWeight: 700, letterSpacing: 1 }}>TDE</span>
            <button onClick={() => { setTdeOn(!tdeOn); setResult(null); }}
              style={{ width: 38, height: 20, borderRadius: 10, border: "none", background: tdeOn ? C.cyan : C.deep, cursor: "pointer", position: "relative" }}>
              <div style={{ width: 16, height: 16, borderRadius: "50%", background: C.white, position: "absolute", top: 2, left: tdeOn ? 20 : 2, transition: "all 0.2s" }}/>
            </button>
          </div>
        </div>
      </div>

      {tdeOn && (
        <div style={{ padding: "7px 24px", background: `${C.cyan}06`, borderBottom: `1px solid ${C.cyan}12`, display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 5, height: 5, borderRadius: "50%", background: C.cyan, animation: "p 2s infinite" }}/>
          <span style={{ fontSize: 10, color: C.cyan, fontWeight: 600 }}>DRiX Brain Connected</span>
          <span style={{ fontSize: 9, color: C.mgray }}>— live API scans, psychographic profiling, power mapping, cached intelligence</span>
          <style>{`@keyframes p{0%,100%{opacity:1}50%{opacity:.3}}`}</style>
        </div>
      )}

      <div style={{ padding: "16px 24px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
          {[["Customer", customer, setCustomer, "e.g. Acme Corp"], ["Solution", solution, setSolution, "e.g. Managed Detection & Response"]].map(([lbl, val, set, ph]) => (
            <div key={lbl}>
              <label style={{ fontSize: 10, fontWeight: 600, color: C.mgray, textTransform: "uppercase", letterSpacing: 1, display: "block", marginBottom: 4 }}>{lbl}</label>
              <input value={val} onChange={e => { set(e.target.value); setResult(null); }} placeholder={ph}
                style={{ width: "100%", padding: "9px 12px", borderRadius: 7, border: `1px solid ${C.deep}`, background: C.deep, color: C.white, fontSize: 13, outline: "none", boxSizing: "border-box" }}/>
            </div>
          ))}
        </div>

        <label style={{ fontSize: 10, fontWeight: 600, color: C.mgray, textTransform: "uppercase", letterSpacing: 1, display: "block", marginBottom: 6 }}>Who is in the meeting?</label>
        <div style={{ display: "flex", gap: 8, marginBottom: tdeOn ? 8 : 10 }}>
          {PERSONAS.map(p => {
            const sel = selected.includes(p.id);
            const ord = selected.indexOf(p.id);
            return (
              <button key={p.id} onClick={() => toggle(p.id)}
                style={{ flex: 1, padding: "10px 12px", borderRadius: 9, border: sel ? `2px solid ${p.color}` : `1px solid ${C.deep}`, background: sel ? `${p.color}12` : C.deep, cursor: "pointer", textAlign: "left", position: "relative" }}>
                {sel && <div style={{ position: "absolute", top: -7, right: -7, width: 20, height: 20, borderRadius: "50%", background: p.color, color: C.navy, fontSize: 11, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>{ord + 1}</div>}
                <div style={{ fontSize: 16, marginBottom: 3 }}>{p.icon}</div>
                <div style={{ fontSize: 12, fontWeight: 700, color: sel ? p.color : C.white }}>{p.label}</div>
                <div style={{ fontSize: 10, color: C.mgray }}>{p.ex}</div>
              </button>
            );
          })}
        </div>

        {/* TDE mode: attendee detail inputs */}
        {tdeOn && selected.length > 0 && (
          <div style={{ background: `${C.cyan}06`, border: `1px solid ${C.cyan}15`, borderRadius: 8, padding: "10px 14px", marginBottom: 10 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.cyan, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>Attendee Details (optional — improves scan accuracy)</div>
            {selected.map(id => {
              const p = PERSONAS.find(x => x.id === id);
              const d = attendeeDetails[id] || {};
              return (
                <div key={id} style={{ display: "flex", gap: 8, marginBottom: 6, alignItems: "center" }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: p.color, minWidth: 60 }}>{p.icon} {p.label.split(" ")[0]}</span>
                  {[["name", "Full name"], ["title", "Title"], ["email", "Email"], ["linkedin", "LinkedIn URL"]].map(([f, ph]) => (
                    <input key={f} value={d[f] || ""} onChange={e => updateDetail(id, f, e.target.value)} placeholder={ph}
                      style={{ flex: 1, padding: "5px 8px", borderRadius: 5, border: `1px solid ${C.cyan}20`, background: C.navy, color: C.white, fontSize: 10, outline: "none", boxSizing: "border-box" }}/>
                  ))}
                </div>
              );
            })}
          </div>
        )}

        {selected.length > 1 && (
          <div style={{ background: C.deep, borderRadius: 7, padding: "8px 12px", marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 10, color: C.mgray }}>Priority:</span>
            <div style={{ display: "flex", gap: 5, flex: 1 }}>
              {selected.map((id, idx) => {
                const p = PERSONAS.find(x => x.id === id);
                return (
                  <div key={id} draggable onDragStart={() => setDragIdx(idx)} onDragOver={e => e.preventDefault()}
                    onDrop={() => { if (dragIdx !== null && dragIdx !== idx) move(dragIdx, idx); setDragIdx(null); }}
                    style={{ padding: "4px 10px", borderRadius: 5, background: `${p.color}20`, border: `1px solid ${p.color}40`, color: p.color, fontSize: 11, fontWeight: 600, cursor: "grab", userSelect: "none" }}>
                    #{idx + 1} {p.label}
                  </div>
                );
              })}
            </div>
            <span style={{ fontSize: 9, color: C.mgray }}>drag to reorder</span>
          </div>
        )}

        <button onClick={generate} disabled={!customer || !solution || selected.length === 0 || loading}
          style={{ width: "100%", padding: "11px", borderRadius: 7, border: "none", background: !customer || !solution || selected.length === 0 ? C.deep : tdeOn ? C.cyan : C.teal, color: C.white, fontSize: 13, fontWeight: 700, cursor: !customer || !solution || selected.length === 0 ? "not-allowed" : "pointer", opacity: !customer || !solution || selected.length === 0 ? 0.5 : 1 }}>
          {loading ? loadMsg : `Generate ${stageLabel} Brief — ${comboLabel()}`}
        </button>
      </div>

      {err && <div style={{ margin: "0 24px", padding: 10, background: "#FEF2F2", borderRadius: 7, color: C.red, fontSize: 12, wordBreak: "break-word" }}>{err}</div>}

      {loading && (
        <div style={{ padding: "32px 24px", textAlign: "center" }}>
          <div style={{ fontSize: 13, color: C.cyan, marginBottom: 10 }}>{loadMsg}</div>
          <div style={{ width: 180, height: 3, background: C.deep, borderRadius: 2, margin: "0 auto", overflow: "hidden" }}>
            <div style={{ width: "40%", height: "100%", background: C.cyan, borderRadius: 2, animation: "ld 1.5s ease-in-out infinite" }}/>
          </div>
          <style>{`@keyframes ld{0%{transform:translateX(-100%)}100%{transform:translateX(350%)}}`}</style>
        </div>
      )}

      {result && !loading && (
        <div style={{ padding: "0 24px 24px" }}>
          <div style={{ background: C.deep, borderRadius: "10px 10px 0 0", padding: "12px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: C.white }}>
              {result.type === "brain" ? "DRiX Intelligence Package" : "Meeting Outline"}
            </div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              <Pill color={stage === "first" ? C.teal : C.amber}>{stageLabel}</Pill>
              <Pill color={result.type === "brain" ? C.cyan : C.mgray}>{result.type === "brain" ? "TDE-Powered" : "Generic AI"}</Pill>
              {selected.map(id => { const p = PERSONAS.find(x => x.id === id); return <Pill key={id} color={p.color}>{p.icon} {p.label}</Pill>; })}
            </div>
          </div>
          {renderResult()}
        </div>
      )}
    </div>
  );
}
