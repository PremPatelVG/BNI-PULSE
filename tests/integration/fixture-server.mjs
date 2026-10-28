// Starts the real dashboard server (src/server.js) on the given port against the in-memory
// test database, seeded with a small made-up region - never the live database.
//   node --import ./tests/helpers/setup.mjs tests/integration/fixture-server.mjs <port>
process.env.PORT = process.argv[2] || "3199";
const { seedRegion } = await import("../helpers/region.mjs");
const fake = await import("../helpers/fake-firestore.mjs");
const { currentWeek } = await import("./week.mjs");

await seedRegion();
const week = currentWeek();
const stamp = "2026-10-01T09:00:00.000Z";
const by = (id, name, role) => ({ filledBy: name, filledByRole: role, savedAt: stamp, updatedAt: stamp, updatedBy: id, updatedByName: name, updatedByRole: role });

// Weekly data. Week of 20-23 Oct: Alpha (Tue) and Beta (Fri) submitted, Gamma (Wed) did not.
const weekly = (chapter, date, fields) => fake.seed("weeklyData", `${chapter}_${date}`, { chapter, date, inductions: 0, drops: 0, ...fields });
weekly("Gamma", "2026-10-14", { membersStart: 20, membersClose: 20, ...by("srdc-1", "Sameer Senior", "srdc") });
weekly("Alpha", "2026-10-20", { membersStart: 30, membersClose: 30, visitors: 3, ...by("dc-alpha", "Dev Alpha", "dc") });
weekly("Beta", "2026-10-23", { membersStart: 25, membersClose: 25, visitors: 2, ...by("dc-beta", "Dina Beta", "dc") });
// This week: Beta's DC has filled it (Beta meets on Fridays); Alpha's is filled during the test.
weekly("Beta", week.fri, { membersStart: 25, membersClose: 25, visitors: 4, references: 9, ...by("dc-beta", "Dina Beta", "dc") });

// Miyagi.
const miyagi = (id, data) => fake.seed("miyagiMembers", id, { status: "active", score: 0, checkpoints: {}, checkins: {}, joinDate: "2025-10-20", lastActivityDate: "2026-10-01", ...data });
miyagi("alpha_ravi_shah", { name: "Ravi Shah", chapter: "Alpha", score: 45, checkpoints: { msp: { done: true }, powerTeam: { done: true }, sponsor1: { done: true }, greenTLR: { done: true } } });
miyagi("alpha_neha_rao", { name: "Neha Rao", chapter: "Alpha", joinDate: "2026-06-01", score: 5, checkpoints: { msp: { done: true } } });
miyagi("alpha_api_member", { name: "Api Member", chapter: "Alpha" });
// Typed text that would run as code if a screen printed it unescaped.
miyagi("alpha_html_name", { name: `<img src=x onerror="window.__xss=1">`, chapter: "Alpha" });
const done = (id, name, chapter, completedDate) => miyagi(id, { name, chapter, status: "graduated", completedDate, statusChangedDate: completedDate, completedBy: "Sameer Senior", finalScore: 60, finalBelt: "Blue", score: 60 });
done("alpha_asha_patel", "Asha Patel", "Alpha", "2026-09-10");
done("gamma_chirag_shah", "Chirag Shah", "Gamma", "2026-10-05");
done("beta_bhavin_desai", "Bhavin Desai", "Beta", "2026-09-20");
done("beta_html_done", `<svg onload="window.__xss=2">`, "Beta", "2026-08-15");

await import("../../src/server.js");
