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

type Cell = { content: string; styles: Record<string, unknown> };
type Block = { heading: string; cols: string[]; body: (string | Cell)[][]; fixed: number[]; classCols: number };

/** Builds the seat list PDF on a single A4 page. Text starts large and bold, and shrinks
 *  (switching to two columns when that keeps it bigger) until every train fits on one page.
 *  `action` downloads it or opens it ready to print in `printWin`. */
export async function makeSeatPdf(trains: PdfTrain[], layout: PdfLayout, action: "download" | "print", printWin?: Window | null) {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
  const list = printableTrains(trains);
  const when = stamp(new Date());
  const sub = layout === "train" ? "Train-wise" : "Destination-wise";

  const cell = (n: number | undefined): Cell =>
    n && n > 0 ? { content: String(n), styles: { fontStyle: "bold", textColor: n <= 10 ? CAUTION : [0, 0, 0] } }
               : { content: "-", styles: { textColor: [160, 160, 160] } };

  // Table content (same for every size attempt). `fixed` are width shares of the table for the leading columns.
  const blocks: Block[] = [];
  if (layout === "train") {
    for (const t of list) {
      const classes = sortClasses([...new Set(t.stops.flatMap(s => Object.keys(s.seats ?? {})))]);
      blocks.push({
        heading: `${t.train_no}  ${t.train_name ?? ""}\nDep ${depText(t)}   |   PF ${pf(t)}   |   Seats at ${hhmm(t.checked_at)}`,
        cols: ["Destination", ...classes], classCols: classes.length, fixed: [0.42],
        body: t.stops.map(s => [`${s.code}  ${s.name ?? ""}`.trim(), ...classes.map(c => cell(s.seats?.[c]))]),
      });
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
      blocks.push({
        heading: `${code}  ${d.name}`.trim(), cols: ["Train", "Dep", "PF", ...classes], classCols: classes.length, fixed: [0.34, 0.2, 0.08],
        body: d.rows.map(r => [`${r.t.train_no}  ${r.t.train_name ?? ""}`.trim(), depText(r.t), pf(r.t), ...classes.map(c => cell(r.seats[c]))]),
      });
    }
  }

  const PAGE = { W: 210, H: 297, M: 8, TOP: 38, BOTTOM: 13, GAP: 5 };
  const colWidth = (ncol: number) => (PAGE.W - 2 * PAGE.M - PAGE.GAP * (ncol - 1)) / ncol;
  const spacing = (scale: number) => 4 * scale + 1;

  const drawBlock = (doc: InstanceType<typeof jsPDF>, b: Block, scale: number, left: number, colW: number, y: number) => {
    const fs = 14 * scale;
    autoTable(doc, {
      startY: y,
      margin: { left, right: PAGE.W - left - colW, top: PAGE.TOP, bottom: PAGE.BOTTOM },
      tableWidth: colW,
      head: [
        [{ content: b.heading, colSpan: b.cols.length, styles: { fillColor: MAROON, textColor: 255, fontStyle: "bold", fontSize: fs * 1.15, halign: "left" } }],
        b.cols.map((h, i) => ({ content: h, styles: { halign: i < b.cols.length - b.classCols ? "left" as const : "center" as const } })),
      ],
      body: b.body as never,
      theme: "grid",
      rowPageBreak: "avoid",
      styles: { font: "helvetica", fontStyle: "bold", fontSize: fs, cellPadding: 1.4 * scale + 0.4, lineColor: [150, 140, 135], lineWidth: 0.25, textColor: 0, valign: "middle" },
      headStyles: { fillColor: TINT, textColor: MAROON, fontStyle: "bold" },
      columnStyles: Object.fromEntries(b.cols.map((_, i) => [i, i < b.fixed.length ? { cellWidth: b.fixed[i] * colW } : { halign: "center" as const }])),
    });
    return (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;
  };

  /** Puts trains down column 1 in departure order, then column 2, and so on. Returns null if they don't fit on one page. */
  const pack = (scale: number, ncol: number, maxPages = 1) => {
    const colW = colWidth(ncol);
    const room = PAGE.H - PAGE.BOTTOM - PAGE.TOP;
    const places: { page: number; col: number; y: number }[] = [];
    let page = 0, col = 0, y = PAGE.TOP;
    for (const b of blocks) {
      const probe = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
      const h = drawBlock(probe, b, scale, PAGE.M, colW, PAGE.TOP) - PAGE.TOP;
      if (probe.getNumberOfPages() > 1 || h > room) return null;
      if (y > PAGE.TOP && y + h > PAGE.H - PAGE.BOTTOM) { col++; y = PAGE.TOP; }
      if (col >= ncol) { page++; col = 0; }
      if (page >= maxPages) return null;
      places.push({ page, col, y });
      y += h + spacing(scale);
    }
    return places;
  };

  const render = (scale: number, ncol: number, places: { page: number; col: number; y: number }[]) => {
    const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    const { W, H, M, TOP } = PAGE;
    const pageCount = places.length ? places[places.length - 1].page + 1 : 1;
    for (let p = 0; p < pageCount; p++) {
    if (p > 0) doc.addPage();
    // Header: big bold title so it can be read from a distance.
    doc.setFillColor(...MAROON); doc.rect(0, 0, W, 30, "F");
    doc.setTextColor(255); doc.setFont("helvetica", "bold");
    doc.setFontSize(27); doc.text("CURRENT RESERVATION AVAILABLE", W / 2, 14, { align: "center" });
    doc.setFontSize(12);
    doc.text(`NORTHERN RAILWAY  |  NEW DELHI (NDLS)  |  ${sub}`, M, 25);
    doc.text(`Printed ${when.text}`, W - M, 25, { align: "right" });
    doc.setTextColor(60); doc.setFontSize(9);
    doc.text("From NDLS. Trains departing in the next 4 hours with chart prepared. Only destinations and classes with seats are listed.", W / 2, 35, { align: "center", maxWidth: W - 2 * M });

    }
    if (blocks.length === 0) {
      doc.setTextColor(0); doc.setFontSize(20);
      doc.text("No trains with current-booking seats right now.", W / 2, TOP + 20, { align: "center" });
    }

    const colW = colWidth(ncol);
    blocks.forEach((b, i) => {
      doc.setPage(places[i].page + 1);
      drawBlock(doc, b, scale, M + places[i].col * (colW + PAGE.GAP), colW, places[i].y);
    });

    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i);
      doc.setDrawColor(150, 140, 135); doc.line(M, H - 10, W - M, H - 10);
      doc.setFontSize(9); doc.setTextColor(60); doc.setFont("helvetica", "bold");
      doc.text("Seat counts change continuously. Confirm at the current booking counter before issuing a ticket.", M, H - 5);
      if (pages > 1) doc.text(`Page ${i} of ${pages}`, W - M, H - 5, { align: "right" });
    }
    return doc;
  };

  // Largest text that fits on one page. More columns are tried only once the text is small enough for them.
  let doc: InstanceType<typeof jsPDF> | null = null;
  for (let s = 1; s >= 0.249 && !doc; s -= 0.05) {
    for (const n of [1, 2, 3]) {
      if ((n === 2 && s > 0.8) || (n === 3 && s > 0.55)) continue;
      const places = pack(s, n);
      if (places) { doc = render(s, n, places); break; }
    }
  }
  // Too many trains for readable text on one page: keep the text readable and continue on further pages.
  if (!doc) doc = render(0.45, 2, pack(0.45, 2, 50) ?? []);

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
