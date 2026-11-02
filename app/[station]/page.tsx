import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import Board, { type BoardStation } from "@/components/Board";
import { createClient } from "@/lib/supabase/server";
import "../board.css";

export const dynamic = "force-dynamic";

async function getStation(raw: string): Promise<BoardStation | null> {
  const code = raw.toUpperCase();
  if (!/^[A-Z]{2,5}$/.test(code)) return null;
  const { data } = await createClient().from("stations")
    .select("code,name_en,name_hi,zone_division,local_codes").eq("code", code).maybeSingle();
  return (data as BoardStation | null) ?? null;
}

export async function generateMetadata({ params }: { params: { station: string } }): Promise<Metadata> {
  const s = await getStation(params.station);
  return s
    ? { title: `${s.code} Current Booking Board`, description: `Live current-booking seats from ${s.name_en}, by train, destination and class` }
    : { title: "Station not found" };
}

/** Public live board for a station other than New Delhi, e.g. /ANVT. New Delhi stays at /. */
export default async function StationBoardPage({ params }: { params: { station: string } }) {
  if (params.station.toUpperCase() === "NDLS") redirect("/");
  const s = await getStation(params.station);
  if (!s) notFound();
  if (params.station !== s.code) redirect(`/${s.code}`);
  return <Board station={s} />;
}
