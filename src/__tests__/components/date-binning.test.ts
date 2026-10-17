import { afterEach, beforeEach, expect, it } from "vitest";
import { binDate } from "@/app/_components/data/DataCharts";

let tz: string | undefined;
// West of UTC, where local getters moved first-of-month dates back a month
beforeEach(() => {
  tz = process.env.TZ;
  process.env.TZ = "America/New_York";
});
afterEach(() => {
  process.env.TZ = tz;
});

it("bins date-only values in UTC, whatever the local time zone", () => {
  expect(binDate("2024-03-01", "day")).toBe("2024-03-01");
  expect(binDate("2024-03-01", "month")).toBe("2024-03");
  expect(binDate("2024-01-01", "year")).toBe("2024");
  // 2024-03-03 is a Sunday: its week starts on Monday 2024-02-26
  expect(binDate("2024-03-03", "week")).toBe("W 2024-02-26");
  expect(binDate("2024-03-04", "week")).toBe("W 2024-03-04");
  expect(binDate("not a date", "month")).toBe("not a date");
});
