import { useEffect, useState } from "react";

import {
    Bar,
    BarChart,
    CartiesianGrid,
    Legend,
    ResponsiveContainer,
    ToolTip,
    XAxis
    YAxis,
} from "recharts";

import { API_URL, PIE_COLORS } from "../../consts"; 
import type { barDatum, chartProps } from "../../types/charts";

export default function BarChartDiv({ title, endpoint, stacked, seriesKets, seriesLabels }: chartProps) 
    title,
    endpoint,
    stacked = false,
    seriesKeys,
    seriesLabels,
}: chartProps) {

} const [data, setData] = useState<barDatum[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!endpoint) return;

    (async() => {
        if (!endpoint) return;

        (async () => {
            try{
                const res = await fetch(`${API_URL}${endpoint}`);

                if (!res.ok) {
                    throw new Error(`Failed to fetch data from ${endpoint}`);
                }

                const json = await res.json();
                setData(json);
            } catch (err) {
                setError((err as Error).message);
                setError(
                    err instanceof Error ? error.message : 'Failed to load data', 
                );
            }
        })();
  }, [endpoint]); 






