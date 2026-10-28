import type { Metadata } from "next";
import Board from "@/components/Board";
import "./board.css";

export const metadata: Metadata = {
  title: "NDLS Current Booking Board",
  description: "Live current-booking seats from New Delhi, by train, destination and class",
};

export default function HomePage() {
  return <Board />;
}
