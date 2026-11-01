import { availableOnly, sortClasses, type Stop } from "@/lib/seats";

export type PdfTrain = {
  train_no: string; train_name: string | null; dep_at: string | null; expected_dep_at: string | null;
  delay_min: number | null; platform: string | null; platform_override: string | null;
  checked_at: string | null; chart_ready: boolean | null; status: string; stops: Stop[];
};
export type PdfLayout = "train" | "destination";

const IST = "Asia/Kolkata";
const hhmm = (s: string | null) =>
  s ? new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: IST }).format(new Date(s)) : "-";
const stamp = (d: Date) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: IST,
  }).formatToParts(d).map(x => [x.type, x.value]));
  return { text: `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute} IST`, file: `${p.year}-${p.month}-${p.day}-${p.hour}${p.minute}` };
};
const depOf = (t: PdfTrain) => new Date(t.expected_dep_at ?? t.dep_at ?? 0).getTime();
const pf = (t: PdfTrain) => t.platform_override ?? t.platform ?? "-";
const depText = (t: PdfTrain) =>
  (t.delay_min ?? 0) >= 5 ? `${hhmm(t.dep_at)} (exp ${hhmm(t.expected_dep_at)}, late ${t.delay_min} min)` : hhmm(t.dep_at);

/** The same trains the public board shows: checked, chart prepared, not yet departed, with seats outside Delhi. */
export function printableTrains(trains: PdfTrain[], now = Date.now()) {
  return trains
    .filter(t => ["active", "error"].includes(t.status) && t.checked_at && t.chart_ready !== false && depOf(t) > now)
    .map(t => ({ ...t, stops: availableOnly(t.stops ?? []) }))
    .filter(t => t.stops.length > 0)
    .sort((a, b) => depOf(a) - depOf(b));
}

const MAROON: [number, number, number] = [123, 30, 44];
const TINT: [number, number, number] = [244, 230, 232];
const CAUTION: [number, number, number] = [178, 106, 0];

/** Builds the seat list PDF. `action` downloads it or opens it ready to print in `printWin`. */
export async function makeSeatPdf(trains: PdfTrain[], layout: PdfLayout, action: "download" | "print", printWin?: Window | null) {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
  const list = printableTrains(trains);
  const when = stamp(new Date());
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
  const M = 12, TOP = 30, BOTTOM = 16;
  const title = layout === "train" ? "Current booking seats - train-wise" : "Current booking seats - destination-wise";

  const pageHead = () => {
    doc.setFillColor(...MAROON); doc.rect(0, 0, W, 18, "F");
    doc.setTextColor(255); doc.setFont("helvetica", "bold"); doc.setFontSize(13);
    doc.text("NORTHERN RAILWAY  |  NEW DELHI (NDLS)", M, 8);
    doc.setFont("helvetica", "normal"); doc.setFontSize(10);
    doc.text(title, M, 14);
    doc.setFontSize(8.5); doc.text(`Printed ${when.text}`, W - M, 14, { align: "right" });
    doc.setTextColor(90); doc.setFontSize(8.5);
    doc.text("From NDLS. Trains departing in the next 4 hours with chart prepared. Only destinations and classes with seats are listed; Delhi-area stations are left out.", M, 24, { maxWidth: W - 2 * M });
  };

  const cell = (n: number | undefined) =>
    n && n > 0 ? { content: String(n), styles: { fontStyle: "bold" as const, textColor: n <= 10 ? CAUTION : [20, 20, 20] as [number, number, number] } }
               : { content: "-", styles: { textColor: [170, 170, 170] as [number, number, number] } };

  let y = TOP;
  let classCols = 0;
  const table = (heading: string, cols: string[], body: (string | ReturnType<typeof cell>)[][], widths: number[]) => {
    const need = 8 + 7 + body.length * 6.5;
    if (y > TOP && y + Math.min(need, 60) > H - BOTTOM) { doc.addPage(); y = TOP; }
    autoTable(doc, {
      startY: y,
      margin: { left: M, right: M, top: TOP, bottom: BOTTOM },
      head: [
        [{ content: heading, colSpan: cols.length, styles: { fillColor: MAROON, textColor: 255, fontStyle: "bold", fontSize: 10, halign: "left" } }],
        cols.map((c, i) => ({ content: c, styles: { halign: i < cols.length - classCols ? "left" as const : "center" as const } })),
      ],
      body,
      theme: "grid",
      showHead: "everyPage",
      rowPageBreak: "avoid",
      styles: { font: "helvetica", fontSize: 9, cellPadding: 1.6, lineColor: [215, 210, 205], lineWidth: 0.2, textColor: 20, valign: "middle" },
      headStyles: { fillColor: TINT, textColor: MAROON, fontStyle: "bold" },
      columnStyles: Object.fromEntries(cols.map((_, i) => [i, i < widths.length ? { cellWidth: widths[i] } : { halign: "center" as const }])),
      willDrawPage: pageHead,
    });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6;
  };

  if (list.length === 0) {
    pageHead();
    doc.setTextColor(40); doc.setFontSize(12);
    doc.text("No trains with current-booking seats right now.", M, TOP + 8);
  } else if (layout === "train") {
    for (const t of list) {
      const classes = sortClasses([...new Set(t.stops.flatMap(s => Object.keys(s.seats ?? {})))]);
      classCols = classes.length;
      const heading = `${t.train_no}  ${t.train_name ?? ""}     Dep ${depText(t)}   |   PF ${pf(t)}   |   Seats as at ${hhmm(t.checked_at)}`;
      table(heading, ["Destination", ...classes],
        t.stops.map(s => [`${s.code}  ${s.name ?? ""}`.trim(), ...classes.map(c => cell(s.seats?.[c]))]), [72]);
    }
  } else {
    const byDest = new Map<string, { name: string; rows: { t: PdfTrain; seats: Record<string, number> }[] }>();
    for (const t of list) for (const s of t.stops) {
      const d = byDest.get(s.code) ?? { name: s.name ?? "", rows: [] };
      d.rows.push({ t, seats: s.seats ?? {} });
      byDest.set(s.code, d);
    }
    const dests = [...byDest.entries()].sort((a, b) => (a[1].name || a[0]).localeCompare(b[1].name || b[0]));
    for (const [code, d] of dests) {
      const classes = sortClasses([...new Set(d.rows.flatMap(r => Object.keys(r.seats)))]);
      classCols = classes.length;
      table(`${code}  ${d.name}`.trim(), ["Train", "Dep", "PF", ...classes],
        d.rows.map(r => [`${r.t.train_no}  ${r.t.train_name ?? ""}`.trim(), depText(r.t), pf(r.t), ...classes.map(c => cell(r.seats[c]))]), [54, 50, 14]);
    }
  }

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setDrawColor(215, 210, 205); doc.line(M, H - 11, W - M, H - 11);
    doc.setFontSize(8); doc.setTextColor(110); doc.setFont("helvetica", "normal");
    doc.text("Seat counts change continuously. Confirm at the current booking counter before issuing a ticket.", M, H - 6.5);
    doc.text(`Page ${i} of ${pages}`, W - M, H - 6.5, { align: "right" });
  }

  const name = `NDLS-seats-${layout === "train" ? "trainwise" : "destinationwise"}-${when.file}.pdf`;
  if (action === "download") { doc.save(name); return list.length; }
  doc.setProperties({ title: name });
  doc.autoPrint();
  const url = URL.createObjectURL(doc.output("blob"));
  if (printWin && !printWin.closed) printWin.location.href = url;
  else window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
  return list.length;
}
