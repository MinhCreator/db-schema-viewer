import { describe, expect, it } from "vitest";
import { t } from "@/lib/i18n/context";
import { en } from "@/lib/i18n/translations/en";
import { fr } from "@/lib/i18n/translations/fr";
import { de } from "@/lib/i18n/translations/de";
import { es } from "@/lib/i18n/translations/es";
import { it as itLocale } from "@/lib/i18n/translations/it";
import { ja } from "@/lib/i18n/translations/ja";
import { ru } from "@/lib/i18n/translations/ru";
import { zh } from "@/lib/i18n/translations/zh";

const locales = { fr, de, es, it: itLocale, ja, ru, zh };
const enKeys = Object.keys(en).sort();

describe("translation catalogs", () => {
  it.each(Object.entries(locales))("%s has exactly the English keys", (_name, catalog) => {
    const keys = Object.keys(catalog).sort();
    expect(keys.filter((key) => !(key in en))).toEqual([]);
    expect(enKeys.filter((key) => !(key in catalog))).toEqual([]);
  });

  it.each(Object.entries(locales))("%s keeps every placeholder of the English text", (_name, catalog) => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    const mismatches = enKeys.filter((key) => {
      const translated = catalog[key];
      return translated !== undefined && placeholders(translated).join() !== placeholders(en[key]!).join();
    });
    expect(mismatches).toEqual([]);
  });
});

describe("t", () => {
  it("inserts parameters literally, even with replacement patterns", () => {
    expect(t("project.delete", { name: "a$&b" })).toBe("Delete a$&b");
    expect(t("project.delete", { name: "x$1$$y$'" })).toBe("Delete x$1$$y$'");
    expect(t("project.delete", { name: "$`" })).toBe("Delete $`");
  });

  it("does not substitute placeholders that appear inside a parameter value", () => {
    expect(t("common.loadedTables", { tables: "{rels}", rels: 2 })).toBe("Loaded {rels} tables, 2 relationships");
  });
});
