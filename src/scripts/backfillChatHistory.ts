import { env } from "../config/env";
import { prisma } from "../lib/prisma";
import { rememberConversation, RememberResult } from "../modules/memory/longTermMemory";

const RESULT_LABELS: Record<RememberResult, string> = {
  summarised: "summarised",
  nothing: "nothing worth remembering (no summary)",
  skipped: "skipped (too short or failed)",
};

function parseArgs(argv: string[]) {
  const emails: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--user") {
      const email = argv[++i];
      if (!email || email.startsWith("--")) throw new Error("--user needs an email address");
      emails.push(email.trim().toLowerCase());
    }
  }
  return {
    emails,
    all: argv.includes("--all"),
    dryRun: argv.includes("--dry-run"),
    recheck: argv.includes("--recheck"),
  };
}

async function main() {
  const { emails, all, dryRun, recheck } = parseArgs(process.argv.slice(2));
  if (emails.length === 0 && !all) {
    console.error("Pass --user <email> (one or more) or --all. See the top of this file for usage.");
    process.exitCode = 1;
    return;
  }
  if (emails.length > 0 && all) {
    console.error("Pass either --user or --all, not both.");
    process.exitCode = 1;
    return;
  }
  if (!env.referenceChatHistory) {
    console.error("REFERENCE_CHAT_HISTORY is false; enable it to backfill.");
    process.exitCode = 1;
    return;
  }

  const users = await prisma.user.findMany({
    where: all ? {} : { email: { in: emails, mode: "insensitive" } },
    select: { id: true, email: true },
    orderBy: { createdAt: "asc" },
  });
  const found = new Set(users.map((u) => u.email.toLowerCase()));
  for (const email of emails) {
    if (!found.has(email)) console.warn(`No user with email ${email}`);
  }

  const totals: Record<RememberResult, number> = { summarised: 0, nothing: 0, skipped: 0 };
  for (const user of users) {
    const conversations = await prisma.conversation.findMany({
      where: {
        userId: user.id,
        activeLeafId: { not: null },
        ...(recheck ? {} : { historySummaryMessages: 0 }),
      },
      select: { id: true, title: true, activeLeafId: true },
      orderBy: { updatedAt: "desc" },
    });
    console.log(`\n${user.email}: ${conversations.length} conversation(s) to ${recheck ? "re-check" : "check"}`);

    const counts: Record<RememberResult, number> = { summarised: 0, nothing: 0, skipped: 0 };
    for (const [i, c] of conversations.entries()) {
      const label = `  [${i + 1}/${conversations.length}] ${c.title ?? "(untitled)"}`;
      if (dryRun) {
        console.log(label);
        continue;
      }
      const result = await rememberConversation(c.id, c.activeLeafId!, { force: recheck });
      console.log(`${label} — ${RESULT_LABELS[result]}`);
      counts[result]++;
      totals[result]++;
    }
    if (!dryRun) {
      console.log(`  ${counts.summarised} summarised, ${counts.nothing} nothing to remember, ${counts.skipped} skipped`);
    }
  }

  if (dryRun) console.log("\nDry run: nothing was written.");
  else {
    console.log(
      `\nDone for ${users.length} user(s): ${totals.summarised} summarised, ` +
        `${totals.nothing} nothing to remember, ${totals.skipped} skipped.`
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
