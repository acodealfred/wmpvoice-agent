/** @type {import('tailwindcss').Config} */
import plugin from "tailwindcss-animate";

export default {
    darkMode: ["class"],
    content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
    theme: {
        extend: {
            borderRadius: {
                lg: "var(--radius)",
                md: "calc(var(--radius) - 2px)",
                sm: "calc(var(--radius) - 4px)"
            },
            colors: {
                background: "hsl(var(--background))",
                foreground: "hsl(var(--foreground))",
                card: {
                    DEFAULT: "hsl(var(--card))",
                    foreground: "hsl(var(--card-foreground))"
                },
                popover: {
                    DEFAULT: "hsl(var(--popover))",
                    foreground: "hsl(var(--popover-foreground))"
                },
                primary: {
                    DEFAULT: "hsl(var(--primary))",
                    foreground: "hsl(var(--primary-foreground))"
                },
                secondary: {
                    DEFAULT: "hsl(var(--secondary))",
                    foreground: "hsl(var(--secondary-foreground))"
                },
                muted: {
                    DEFAULT: "hsl(var(--muted))",
                    foreground: "hsl(var(--muted-foreground))"
                },
                accent: {
                    DEFAULT: "hsl(var(--accent))",
                    foreground: "hsl(var(--accent-foreground))"
                },
                destructive: {
                    DEFAULT: "hsl(var(--destructive))",
                    foreground: "hsl(var(--destructive-foreground))"
                },
                border: "hsl(var(--border))",
                input: "hsl(var(--input))",
                ring: "hsl(var(--ring))",
                chart: {
                    1: "hsl(var(--chart-1))",
                    2: "hsl(var(--chart-2))",
                    3: "hsl(var(--chart-3))",
                    4: "hsl(var(--chart-4))",
                    5: "hsl(var(--chart-5))"
                },
                // Literal palette from the Petroleum UI guide (CIQ-RP-PET-001), for
                // one-off utility usage (SVG strokes, gradient stops) that the
                // theme-scoped --ciq-* custom properties don't cover. Prefer the
                // --ciq-* tokens for anything that should adapt across themes.
                petroleum: {
                    crude: "#0A0C0E",
                    derrick: "#12171B",
                    steel: "#1E262C",
                    "steel-2": "#2A343C",
                    cyan: "#4FA9E8",
                    "cyan-deep": "#2A7FC8",
                    navy: "#16395B",
                    sodium: "#F0A63C",
                    flare: "#E4572E",
                    vapour: "#35C08A",
                    halogen: "#E8EDF0",
                    mud: "#7C8892",
                    "mud-dim": "#4A555E"
                }
            },
            fontFamily: {
                display: ["var(--font-display)"],
                sans: ["var(--font-body)"],
                mono: ["var(--font-mono)"]
            },
            fontSize: {
                "7xl": ["4.5rem", { lineHeight: "1.3" }],
                "4xl": ["2.5rem", { lineHeight: "3.2rem" }],
                "3xl": ["2rem", { lineHeight: "2.8rem" }],
                // Petroleum guide § 3.2 type scale — instrument numerals/titles.
                "numeral-xl": ["3.875rem", { lineHeight: "0.9" }],
                "display-xl": ["2.75rem", { lineHeight: "0.98" }]
            }
        }
    },
    plugins: [plugin]
};
