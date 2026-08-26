// Builds three role-specific user guides for Sicilian Growth Tracker as .docx files:
//   1. Support Ambassador & Chapter Director Guide
//   2. Senior Director Guide
//   3. Area Director & BNI Office (Master) Administration Guide
//
//   node docs/build_user_guides.js
//
// Uses the preinstalled `docx` npm package. Screenshots are pulled from docs/screenshots/.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, PageBreak,
  Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType, LevelFormat,
  TableOfContents, Footer, PageNumber, ImageRun, PageOrientation
} = require("docx");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SHOTS = path.join(ROOT, "docs", "screenshots");

const NAVY = "1A1F2E", RED = "E63946", GREEN = "2D9B6F", AMBER = "B26B00", MUTED = "6B7280", GREY = "E5E7EB", LIGHT = "F0F2F7";

// ---------- primitives ----------
const runs = (parts) => (Array.isArray(parts) ? parts : [parts]).map(p =>
  typeof p === "string" ? new TextRun({ text: p, size: 21 }) : new TextRun({ size: 21, ...p }));

const P = (parts, opts = {}) => new Paragraph({ children: runs(parts), spacing: { after: 120, line: 276 }, ...opts });

const H = (text, level) => new Paragraph({
  heading: level === 1 ? HeadingLevel.HEADING_1 : level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
  spacing: { before: level === 1 ? 320 : 220, after: 120 },
  children: [new TextRun({ text, bold: true, color: level === 1 ? RED : NAVY, size: level === 1 ? 30 : level === 2 ? 25 : 22 })]
});

const bullet = (text, level = 0) => new Paragraph({
  numbering: { reference: "bl", level },
  spacing: { after: 60, line: 270 },
  children: runs(text)
});

const numItem = (text) => new Paragraph({ numbering: { reference: "nl", level: 0 }, spacing: { after: 70, line: 270 }, children: runs(text) });

function callout(title, body, color = NAVY) {
  const border = { style: BorderStyle.SINGLE, size: 4, color };
  return new Paragraph({
    spacing: { before: 120, after: 160 },
    shading: { type: ShadingType.CLEAR, color: "auto", fill: LIGHT },
    border: { top: border, bottom: border, left: { style: BorderStyle.SINGLE, size: 18, color }, right: border },
    children: [
      new TextRun({ text: title + "  ", bold: true, color, size: 21 }),
      ...runs(body)
    ]
  });
}

function table(head, rows, widths) {
  const total = 9360;
  const w = widths || head.map(() => Math.round(total / head.length));
  const headerRow = new TableRow({
    tableHeader: true,
    children: head.map((h, i) => new TableCell({
      width: { size: w[i], type: WidthType.DXA },
      shading: { type: ShadingType.CLEAR, color: "auto", fill: NAVY },
      margins: { top: 60, bottom: 60, left: 90, right: 90 },
      children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, color: "FFFFFF", size: 20 })] })]
    }))
  });
  const bodyRows = rows.map((r, ri) => new TableRow({
    children: r.map((c, i) => new TableCell({
      width: { size: w[i], type: WidthType.DXA },
      shading: ri % 2 ? { type: ShadingType.CLEAR, color: "auto", fill: "F7F8FB" } : undefined,
      margins: { top: 50, bottom: 50, left: 90, right: 90 },
      children: [new Paragraph({ spacing: { line: 264 }, children: runs(Array.isArray(c) ? c : [{ text: String(c), size: 20 }]).map(x => x) })]
    }))
  }));
  return new Table({
    columnWidths: w,
    width: { size: total, type: WidthType.DXA },
    rows: [headerRow, ...bodyRows],
    borders: {
      top: { style: BorderStyle.SINGLE, size: 2, color: GREY }, bottom: { style: BorderStyle.SINGLE, size: 2, color: GREY },
      left: { style: BorderStyle.SINGLE, size: 2, color: GREY }, right: { style: BorderStyle.SINGLE, size: 2, color: GREY },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: GREY }, insideVertical: { style: BorderStyle.SINGLE, size: 1, color: GREY }
    }
  });
}

function image(file, caption, w = 600) {
  const p = path.join(SHOTS, file);
  const kids = [];
  if (fs.existsSync(p)) {
    const data = fs.readFileSync(p);
    const isPng = data[0] === 0x89;
    const nat = isPng ? { w: data.readUInt32BE(16), h: data.readUInt32BE(20) } : { w: 1440, h: 1000 };
    const width = Math.min(w, nat.w);
    const height = Math.round(width * nat.h / nat.w);
    kids.push(new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { before: 120, after: 40 },
      children: [new ImageRun({ type: isPng ? "png" : "jpg", data, transformation: { width, height } })]
    }));
  } else {
    const b = { style: BorderStyle.DASHED, size: 6, color: MUTED };
    kids.push(new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { before: 160, after: 40 },
      shading: { type: ShadingType.CLEAR, color: "auto", fill: LIGHT },
      border: { top: b, bottom: b, left: b, right: b },
      children: [new TextRun({ text: "[ Screenshot to be added — save as docs/screenshots/" + file + " and re-run the build ]", italics: true, color: MUTED, size: 19 })]
    }));
  }
  if (caption) kids.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 160 }, children: [new TextRun({ text: caption, italics: true, color: MUTED, size: 18 })] }));
  return kids;
}

function coverAndToc(title, subtitle, audience) {
  return [
    new Paragraph({ spacing: { before: 1600, after: 0 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: "SICILIAN", bold: true, color: RED, size: 60 }), new TextRun({ text: " GROWTH TRACKER", bold: true, color: NAVY, size: 60 })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 400 }, children: [new TextRun({ text: "Regional Leadership Dashboard  ·  BNI Ahmedabad", color: MUTED, size: 22 })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 60 }, children: [new TextRun({ text: title, bold: true, color: NAVY, size: 40 })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 500 }, children: [new TextRun({ text: subtitle, color: RED, size: 26 })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 40 }, children: [new TextRun({ text: "Audience: " + audience, bold: true, color: NAVY, size: 22 })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "Version 1.0  ·  " + new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }), color: MUTED, size: 20 })] }),
    callout("About the screenshots.", "Screenshots are taken from the live system. A few illustrative names and figures (for example on the Renewals screen) are sample data used only to show how a populated screen looks.", NAVY),
    new Paragraph({ children: [new PageBreak()] }),
    H("Contents", 1),
    new TableOfContents("Contents", { hyperlink: true, headingStyleRange: "1-2" }),
    new Paragraph({ children: [new PageBreak()] })
  ];
}

function buildDoc(meta, blocks) {
  return new Document({
    creator: "Sicilian Growth Tracker",
    title: meta.title,
    styles: {
      default: { document: { run: { font: "Calibri", size: 21, color: "222222" } } },
      paragraphStyles: [
        { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true, run: { bold: true, color: RED, size: 30 } },
        { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, run: { bold: true, color: NAVY, size: 25 } }
      ]
    },
    numbering: {
      config: [
        { reference: "bl", levels: [
          { level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraphProperties: { indent: { left: 460, hanging: 260 } } } },
          { level: 1, format: LevelFormat.BULLET, text: "◦", alignment: AlignmentType.LEFT, style: { paragraphProperties: { indent: { left: 880, hanging: 260 } } } }
        ] },
        { reference: "nl", levels: [
          { level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraphProperties: { indent: { left: 460, hanging: 260 } } } }
        ] }
      ]
    },
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1200, bottom: 1200, left: 1300, right: 1300 } } },
      footers: { default: new Footer({ children: [new Paragraph({
        alignment: AlignmentType.CENTER, border: { top: { style: BorderStyle.SINGLE, size: 2, color: GREY, space: 6 } },
        children: [new TextRun({ text: "Sicilian Growth Tracker  ·  " + meta.title + "  ·  Page ", color: MUTED, size: 16 }), new TextRun({ children: [PageNumber.CURRENT], color: MUTED, size: 16 })]
      })] }) },
      children: [...coverAndToc(meta.title, meta.subtitle, meta.audience), ...blocks]
    }]
  });
}

// ============================ SHARED CONTENT ============================
const LOGIN_BLOCK = (who) => [
  H("Signing in", 1),
  numItem([{ text: "Open the dashboard in any browser (the live web address is provided by your Area Director / BNI Office)." }]),
  numItem("On the sign-in screen, choose your name from the “Your Name” list."),
  numItem([{ text: who }]),
  numItem("Enter your 4– to 6-digit PIN and press Sign In."),
  callout("Sessions last 12 hours.", "After that you simply sign in again. If you forget your PIN, ask the person who issued it (your Senior Director, or the Area Director / BNI Office).", NAVY)
];

const WEEKLY_FIELDS = [
  ["Chapter", "The chapter this entry is for. Fixed to your own chapter."],
  ["Week / Meeting date", "The week of the meeting you are reporting. Each chapter reports once per meeting week."],
  ["Members (Start)", "Head-count of members at the start of the week / month, used to calculate net movement."],
  ["Members (Close)", "Head-count at the end of the week — the current roster size."],
  ["Inductions", "Number of NEW members inducted this week (people who joined)."],
  ["Drops", "Number of members who LEFT this week (did not renew / resigned)."],
  ["BNI Connect", "Members registered / active on BNI Connect."],
  ["Visitors", "Total visitors who attended the meeting."],
  ["Positive Visitors", "Of those visitors, how many are strong prospects likely to join."],
  ["EOI – Yes / Maybe / No", "Expressions of Interest collected from visitors: how many said Yes, Maybe, or No to joining. For each 'Yes/Maybe' you can add the visitor's name and category."],
  ["Concall", "Did the chapter join the weekly leadership conference call? Yes / No."],
  ["TLR", "The chapter's Traffic-Light score (0–100). Normally set region-wide from the monthly TLR report; can be noted here."],
  ["121s", "Number of one-to-one meetings held between members this week."],
  ["References", "Number of referrals passed between members this week."],
  ["TYFCB", "“Thank You For Closed Business” — the rupee value of business closed from referrals this week."],
  ["Renewals (this month)", "How many members renewed their membership this month."],
  ["Success Story", "A short note on a win, testimonial or closed-business story to celebrate (optional)."],
  ["Who Visited the Chapter", "Select the member(s) from the leadership team who visited the chapter this week, or choose “No Visit”."]
];

const OVERVIEW_STATS = [
  ["Submitted", "How many chapters (of those you can see) have entered data for the selected week, e.g. 12/58."],
  ["Members", "Total members across the shown chapters (from the latest close count)."],
  ["Inductions", "Total new members inducted this week (green)."],
  ["Drops", "Total members lost this week (red)."],
  ["Wk Net", "Weekly net = Inductions − Drops."],
  ["Mo Net", "Month-to-date net movement (each chapter uses its own month)."],
  ["Visitors", "Total visitors across shown chapters this week."],
  ["Pipeline", "Prospects currently in the visitor pipeline."],
  ["TLR Gap", "TLR target size vs actual members, summed — how far chapters are from their traffic-light target size."]
];

// ============================ DOC 1: SA & DC ============================
const doc1 = buildDoc(
  { title: "Support Ambassador & Chapter Director Guide", subtitle: "Running your chapter week to week", audience: "Chapter Directors (DC) & Support Ambassadors (SA)" },
  [
    H("1. What this system is", 1),
    P("Sicilian Growth Tracker is the shared dashboard the BNI Ahmedabad leadership team uses to track every chapter's weekly health — members, visitors, referrals, renewals and new-member onboarding — in one place. As a Chapter Director (DC) or Support Ambassador (SA) you are the person on the ground who keeps your chapter's numbers up to date."),
    callout("Your golden rule:", "After every chapter meeting, submit your weekly numbers. Almost everything the Senior Directors and Area Director see rolls up from that one weekly entry.", RED),

    ...LOGIN_BLOCK("Chapter Directors sign in with their own name (for example “Niraj Goswami”). Support Ambassadors sign in with the single shared chapter account named “<Chapter> SA” — for example “Acreseus SA”. Every SA in a chapter uses that one login."),
    callout("One SA login per chapter.", "Each chapter now has exactly one DC login and one SA login. All Support Ambassadors in the chapter share the “<Chapter> SA” account and PIN. A DC and an SA have the same rights over their own chapter.", NAVY),

    H("2. What you can see", 1),
    P("You see only your own chapter. A DC and SA can view and edit their chapter's data; you cannot see or change other chapters. The tabs you will use most are Overview, Call Mode (weekly data entry), Renewals and Miyagi."),

    H("3. Weekly data entry — your main job", 1),
    P("This is the most important thing you do. Open Call Mode (or the weekly entry form), pick the meeting week, and fill in the fields below. Save when done. Do this once per meeting week."),
    table(["Field", "What to enter"], WEEKLY_FIELDS, [2600, 6760]),
    callout("Members Start vs Close.", "“Start” is the roster at the beginning of the period and “Close” is the roster now. The system uses the two to work out your weekly and monthly net growth automatically — so keep them accurate.", NAVY),
    ...image("weekly-entry.png", "The weekly data-entry form — where you enter the fields above after each meeting, then press Save."),

    H("4. Reading the Overview", 1),
    P("The Overview shows a card for your chapter. Until you submit for the selected week, the card reads “Not Submitted” and shows no numbers — that is normal, it just means the week's entry is still pending. Once you save, the card fills in with your members, inductions, drops, weekly/monthly net, TLR score and conversion rate."),
    ...image("02-area-overview.png", "The Overview. Leaders see every chapter; you see your own. Cards marked “Not Submitted” are simply waiting for that week's entry."),

    H("5. Renewals", 1),
    P("The Renewals tab lists your chapter's members whose membership is coming up for renewal, and any that are overdue. The list is built from the Members Due report that the Area Director / BNI Office uploads centrally — you do not upload it."),
    bullet([{ text: "Each member shows their name, phone number, business and renewal due date." }]),
    bullet([{ text: "OVERDUE (red): ", bold: true, color: RED }, { text: "when a member's renewal date has passed and they have not renewed, their row turns red and shows a running count of how many days overdue they are (−1, −2, −3 …)." }]),
    bullet([{ text: "When a member renews, press ", }, { text: "Mark Done", bold: true }, { text: " so they drop off the outstanding list." }]),
    callout("Overdue members are never lost.", "Even when a lapsed member disappears from the next uploaded report, the system keeps showing them as overdue until they renew or are marked done — so nobody slips through the cracks.", GREEN),
    ...image("renewals-overdue.png", "The Renewals list — an overdue member shows as a red row with a running “−days” overdue count and their phone number (members shown are sample data)."),

    H("6. Miyagi / 1YRC — new-member onboarding", 1),
    P("Miyagi tracks every member in their first year (0–12 months). It helps you make sure new members are properly inducted and supported."),
    bullet("Belts & points: as you complete onboarding checkpoints for a member, they earn points and progress through belts."),
    bullet([{ text: "Check-ins at 3, 6, 9 and 12 months: ", bold: true }, { text: "each member is due a structured check-in at these milestones. The check-in appears two weeks before it is due and turns red “OVERDUE” if it passes without being completed." }]),
    bullet([{ text: "Warnings: ", bold: true }, { text: "“Never Started” (no checkpoints yet) and “Stalled” (no activity for 2+ weeks) flag members who need attention." }]),
    table(["Milestone", "When it appears", "When it turns OVERDUE"], [
      ["3-month check-in", "2 weeks before the 3-month mark", "the day after the 3-month date, if not submitted"],
      ["6-month check-in", "2 weeks before the 6-month mark", "the day after the 6-month date, if not submitted"],
      ["9-month check-in", "2 weeks before the 9-month mark", "the day after the 9-month date, if not submitted"],
      ["12-month check-in", "2 weeks before the 12-month mark", "the day after the 12-month date, if not submitted"]
    ], [2400, 3480, 3480]),
    ...image("miyagi.png", "The Miyagi / 1YRC tab — member belts, check-ins due at 3/6/9/12 months, and Stalled / Never-Started warnings."),

    H("7. Weekly checklist", 1),
    numItem("After your meeting, open Call Mode and submit the weekly entry (all fields above)."),
    numItem("Check the Renewals tab — chase any member who is due or overdue; Mark Done when they renew."),
    numItem("Check Miyagi — complete any check-in that is due, and act on “Stalled” / “Never Started” flags."),
    numItem("Glance at your Overview card to confirm your numbers look right.")
  ]
);

// ============================ DOC 2: SENIOR DIRECTOR ============================
const doc2 = buildDoc(
  { title: "Senior Director Guide", subtitle: "Overseeing your chapters at a glance", audience: "Senior Directors (SrDC)" },
  [
    H("1. Your role in the system", 1),
    P("As a Senior Director you oversee a group of chapters (typically 5–9) and their Chapter Directors and Support Ambassadors. Sicilian Growth Tracker gives you a single live view of how every one of your chapters is performing each week, so you can spot which chapters need a nudge and drive the region's growth targets."),

    ...LOGIN_BLOCK("Senior Directors sign in with their own name (for example “Harsh Tanna”)."),

    H("2. What you can see and do", 1),
    bullet("You see all chapters in your group — their weekly submissions, growth, renewals and new-member health."),
    bullet("You can review and, where needed, edit chapter data; and you can generate a WhatsApp summary to share with your team."),
    bullet([{ text: "Region-wide actions — uploading the monthly TLR report and changing region settings — are reserved for the Area Director / BNI Office.", }]),

    H("3. The Overview — your weekly command centre", 1),
    P("Pick a week with the week chips at the top. The stat bar summarises all your chapters for that week, and each chapter shows a card. Cards marked “Not Submitted” are waiting on that chapter's weekly entry — that is your cue to chase the DC/SA."),
    ...image("02-area-overview.png", "The Overview: summary stats across your chapters, then a card per chapter. “Not Submitted” means the week's entry is still pending."),
    P([{ text: "What each summary stat means:", bold: true }]),
    table(["Stat", "Meaning"], OVERVIEW_STATS, [2200, 7160]),
    callout("Why does it look empty?", "The Overview is driven by weekly submissions, not by the TLR report. If a week shows mostly “Not Submitted”, the chapters simply have not entered data for that week yet — switch weeks or chase the entries.", AMBER),

    H("4. Reading a chapter card", 1),
    P("Once a chapter submits, its card shows Members, Inductions, Drops, Weekly Net, Monthly Net, Conversion %, the TLR score and a TLR-vs-actual gap note. Click a card to drill into that chapter's full history."),

    H("5. The data behind the numbers — what chapters submit each week", 1),
    P("Every chapter card and roll-up is built from the weekly entry your Chapter Directors and Support Ambassadors submit after each meeting. Knowing these fields helps you interpret the numbers and coach your teams on accurate reporting."),
    table(["Field", "What it means"], WEEKLY_FIELDS, [2600, 6760]),
    ...image("weekly-entry.png", "The weekly data-entry form your DCs and SAs complete after each meeting."),

    H("6. Renewals oversight", 1),
    P("The Renewals tab shows every member across your chapters who is due or overdue. Overdue members appear as red rows with a running “days overdue” count and their phone number. Use this to make sure your DCs are following up and marking renewals done."),
    ...image("renewals-overdue.png", "Renewals across your chapters — overdue members in red with the running “−days” count and phone numbers (members shown are sample data)."),

    H("7. Miyagi / 1YRC oversight", 1),
    P("Miyagi shows the health of every first-year member across your chapters — belts earned, check-ins due at 3/6/9/12 months, and “Stalled” or “Never Started” warnings. Use it to make sure new members everywhere are being onboarded, not just the well-run chapters."),
    ...image("miyagi.png", "The Miyagi / 1YRC tab — belts, check-ins due, and Stalled / Never-Started warnings."),

    H("8. Reports & analytics", 1),
    P("Beyond the Overview you have a set of read-across views to run your group:"),
    table(["Tab", "What it gives you"], [
      ["TLR Report", "The full traffic-light table for the region / your chapters, from the latest monthly upload."],
      ["Reports", "Scorecard-style rollups you can review and export to CSV."],
      ["Retention", "Renewal / retention performance over a chosen window."],
      ["Pipeline", "Visitor pipeline — prospects moving toward joining."],
      ["Planning", "Forward planning view for targets and gaps."],
      ["Risk Radar", "Chapters at risk (low TLR, negative net, missed submissions)."],
      ["Retrospective", "Historical look-back across weeks/months."],
      ["Goals", "Chapter goals and progress."],
      ["SD Report / WhatsApp", "One-tap summary of your chapters to paste into WhatsApp."]
    ], [2200, 7160]),
    ...image("reports.png", "Reports view — rollups that can be exported to CSV."),
    ...image("retention.png", "Retention view — renewal performance over a chosen window."),

    H("9. Weekly cadence", 1),
    numItem("Early in the week, open the Overview for the current week and see who has and hasn't submitted."),
    numItem("Chase any “Not Submitted” chapters via their DC/SA."),
    numItem("Scan Renewals and Miyagi for anything overdue in your chapters."),
    numItem("Generate and share your WhatsApp summary with your team.")
  ]
);

// ============================ DOC 3: AD & BNI OFFICE ============================
const doc3 = buildDoc(
  { title: "Area Director & BNI Office Administration Guide", subtitle: "Running the whole region and the data that powers it", audience: "Area Director & BNI Office (Master)" },
  [
    H("1. System overview", 1),
    P("Sicilian Growth Tracker is the regional leadership dashboard for BNI Ahmedabad. It is a single web app backed by a live cloud database (Firestore): every change — a weekly entry, a renewal marked done, an uploaded report — syncs to everyone in real time, with no manual refresh. As Area Director / BNI Office you have full visibility across all chapters and you own the region-wide data uploads and settings."),

    H("2. Roles & login model", 1),
    table(["Role", "Scope", "Login"], [
      ["Area Director (AD)", "Whole region; all uploads & settings", "Own name (2 accounts)"],
      ["BNI Office (Master)", "Full access fallback account", "“BNI Office Account – Full Access”"],
      ["Senior Director (SrDC)", "Their group of chapters (5–9)", "Own name (8 accounts)"],
      ["Chapter Director (DC)", "Their own chapter", "Own name (51 accounts)"],
      ["Support Ambassador (SA)", "Their own chapter (same rights as DC)", "“<Chapter> SA” — one shared login per chapter (58)"],
      ["Viewer", "Read-only", "Own name"]
    ], [2600, 3760, 3000]),
    callout("One DC + one SA login per chapter.", "Every chapter has exactly one Chapter Director login and one shared “<Chapter> SA” login. DC/SrDC/AD PINs live in member-pins.csv; the 58 chapter-SA PINs live in sa-logins.csv (the only copy — keep it safe).", NAVY),

    H("3. Data uploads — the mandates", 1),
    P("Three reports feed the whole system. All are uploaded from the Upload tab. Uploads apply in seconds and propagate live to every user."),
    ...image("upload-panel.png", "The Upload tab — where the Region TLR, Members Due and Membership Length reports are uploaded."),

    H("3a. Region TLR (Traffic-Light) report — AD / BNI Office only", 2),
    table(["Question", "Answer"], [
      ["What is it?", "The monthly per-chapter Traffic-Light report (chapter score, size, colour breakdown, conversion)."],
      ["Who can upload?", "Area Director / BNI Office master only. Others see a message and cannot upload it."],
      ["Which month does it update?", "The month is read from the report itself. If it is not the current or previous month, you are asked to confirm before it applies."],
      ["Where does the data show?", "1) The TLR Report tab — the full table, always, right after upload. 2) The Overview — each chapter card's TLR score, TLR bar, Conversion % and a “TLR vs Actual” gap note, plus the top “TLR Gap” stat — but only on chapters that also submitted weekly data for the viewed week. 3) Call Mode — the TLR summary. 4) The chapter drill-down."],
      ["How is it matched to chapters?", "By chapter name. If a report's chapter names don't match the system's chapter names, that chapter's score won't attach (shows ‘-’)."],
      ["How long does it take?", "Seconds. It writes the region snapshot and refreshes that month's weekly entries in one batch; a live listener updates every screen automatically — no refresh needed. The status line confirms “Updated N chapters for <month>”."]
    ], [2500, 6860]),
    callout("If the TLR seems ‘not to show’:", "Check the TLR Report tab first — it always shows the upload. On the Overview, the TLR only appears next to chapters that have submitted weekly data for the week you're viewing, because the Overview is a weekly-submission board.", AMBER),
    ...image("tlr-report.png", "The TLR Report tab — the full region traffic-light table, shown immediately after the upload regardless of weekly submissions."),

    H("3b. Members Due (Renewals) report", 2),
    table(["Question", "Answer"], [
      ["What is it?", "The upcoming-renewals export: Chapter, First/Last name, Company, Renewal Date, Email, Address, Phone Number."],
      ["Where does the data show?", "The Renewals tab — members listed by chapter with their renewal date and phone number."],
      ["Overdue handling", "When a member's renewal date passes and they are not renewed, their row turns red and shows a running negative count of days overdue (−1, −2, −3 …)."],
      ["Lapsed members are preserved", "Re-uploading a newer report does NOT delete a lapsed member who dropped off it — they are kept and shown as overdue until they renew or are marked done. Members who renewed reappear with their new date and update normally."],
      ["Duplicate uploads are ignored", "If you upload a report whose data matches what is already on file, the system detects it and does not re-write anything (“Already up to date”)."],
      ["How long does it take?", "Instant — it applies and the Renewals tab updates live."]
    ], [2500, 6860]),
    ...image("renewals-overdue.png", "The Renewals tab after a Members Due upload — overdue rows in red with the running “−days” count and each member's phone number (members shown are sample data)."),

    H("3c. Membership Length report — feeds Miyagi / 1YRC", 2),
    table(["Question", "Answer"], [
      ["What is it?", "Each member's tenure (e.g. “0 years (4 months)”) with their chapter and start date."],
      ["Where does the data show?", "The Miyagi / 1YRC tab. It drives which members are tracked as first-year."],
      ["Automatic behaviour", "Members under 12 months are auto-added to Miyagi; members who reach 12 months are auto-graduated; members missing from both the length and dues reports are auto-dropped."],
      ["Robust parsing", "The parser reads columns by their headings (not fixed positions), so it tolerates re-ordered or partially-empty reports and collects every tenure from 0 up to 11 months."],
      ["How long does it take?", "Instant — Miyagi updates live after upload."]
    ], [2500, 6860]),
    ...image("miyagi.png", "The Miyagi / 1YRC tab that the Membership Length report feeds — belts, check-ins and onboarding warnings."),

    H("4. Every weekly data field", 1),
    P("Chapters submit these each meeting week. Understanding them helps you read the Overview and reports."),
    table(["Field", "Meaning"], WEEKLY_FIELDS, [2600, 6760]),
    ...image("weekly-entry.png", "The weekly data-entry form chapters complete each meeting."),

    H("5. The Overview & its stats", 1),
    P("The Overview is the region's weekly heartbeat. Remember it is driven by weekly submissions — chapters that have not submitted show “Not Submitted”."),
    ...image("02-area-overview.png", "Area Director Overview: targets, region filters, the summary stat bar, and a card per chapter."),
    table(["Summary stat", "Meaning"], OVERVIEW_STATS, [2400, 6960]),

    H("6. Area Director targets", 1),
    table(["Target", "What it tracks"], [
      ["Total Members / Score", "Region member count against the annual score target."],
      ["Cumulative Net Added", "Net member movement (inductions − drops) over a rolling window you choose (30/60/90 days, etc.)."],
      ["Support Scorecard Target", "The support year's induction target, split by quarter (e.g. 174 per quarter, 696 for the year), with drops and net tracked per quarter."]
    ], [2600, 6760]),

    H("7. Analytics & reporting tabs", 1),
    table(["Tab", "Purpose"], [
      ["TLR Report", "Full region traffic-light table from the latest monthly upload."],
      ["Reports", "Scorecard rollups; export to CSV."],
      ["Retention", "Renewal / retention performance over a window."],
      ["Pipeline", "Visitor pipeline across the region."],
      ["Planning", "Targets, gaps and forward planning."],
      ["Risk Radar", "Chapters at risk — low TLR, negative net, missed submissions."],
      ["Retrospective", "Historical look-back."],
      ["Goals", "Chapter goals and progress."],
      ["Activity Log", "Audit trail of who did what (uploads, edits, logins)."],
      ["Settings", "Branding, chapter logo, team call day, BNI Office PIN."]
    ], [2200, 7160]),
    ...image("retention.png", "Retention analytics."),
    ...image("pipeline.png", "Visitor pipeline."),
    ...image("planning.png", "Planning view."),
    ...image("risk.png", "Risk Radar — chapters needing attention."),

    H("8. Login & credential management", 1),
    bullet("member-pins.csv holds the AD, Senior Director and Chapter Director logins and PINs."),
    bullet("sa-logins.csv holds the 58 chapter Support-Ambassador logins (“<Chapter> SA”) and their PINs — this is the only copy, so store it securely and distribute PINs per chapter."),
    bullet("The BNI Office master PIN is changed from Settings."),
    ...image("settings.png", "Settings — branding, team call day and the BNI Office PIN. (The logo URL fields have since been replaced by the built-in BNI Ahmedabad and Sicilian Ventures logos.)"),

    H("9. How the data syncs", 1),
    P("Every value lives in the cloud database and is streamed to each open screen live. When you upload a report or a chapter saves an entry, everyone's view updates within a second or two — there is no scheduled job or manual refresh. If a screen ever looks stale, a browser refresh re-subscribes."),

    H("10. Operating cadence", 1),
    numItem("Weekly: watch the Overview for submissions; make sure Senior Directors are chasing “Not Submitted” chapters."),
    numItem("Monthly: upload the Region TLR report; confirm it lands on the TLR Report tab."),
    numItem("As reports arrive: upload the Members Due and Membership Length reports to keep Renewals and Miyagi current."),
    numItem("Ongoing: use Risk Radar and Retention to target support where it is needed most.")
  ]
);

// ============================ WRITE ============================
const outputs = [
  ["SGT_SA_and_DC_Guide.docx", doc1],
  ["SGT_Senior_Director_Guide.docx", doc2],
  ["SGT_AreaDirector_BNIOffice_Guide.docx", doc3]
];
for (const [name, doc] of outputs) {
  const buf = await Packer.toBuffer(doc);
  let out = path.join(ROOT, "docs", name);
  try {
    fs.writeFileSync(out, buf);
  } catch (e) {
    if (e.code === "EBUSY" || e.code === "EPERM") {
      out = out.replace(/\.docx$/, "__updated.docx");
      fs.writeFileSync(out, buf);
      console.log("  (original was open/locked — wrote " + path.basename(out) + " instead)");
    } else throw e;
  }
  console.log("wrote " + path.relative(ROOT, out).replace(/\\/g, "/") + "  (" + Math.round(buf.length / 1024) + " KB)");
}
console.log("done");
