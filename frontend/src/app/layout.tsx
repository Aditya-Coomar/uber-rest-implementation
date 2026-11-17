import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Instrument_Sans } from "next/font/google";
import "./globals.css";

const display = Bricolage_Grotesque({
  variable: "--font-display",
  subsets: ["latin"],
  axes: ["wdth", "opsz"],
});

const ui = Instrument_Sans({
  variable: "--font-ui",
  subsets: ["latin"],
  axes: ["wdth"],
});

export const metadata: Metadata = {
  title: "Kerb — get a ride",
  description: "Book a ride across the city. A service-oriented ride-booking simulation.",
};

export const viewport: Viewport = {
  themeColor: "#f7f8f4",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${display.variable} ${ui.variable} h-full`}>
      <body className="h-full">{children}</body>
    </html>
  );
}
