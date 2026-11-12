// The one stats service for this server process, wired to the database and email. Server only.
import { createServiceRoleClient } from '@/lib/supabase-server';
import { sendEmail } from '@/lib/mailer';
import { config } from './config';
import { createStatsService, type StatsService } from './service';
import { createSupabaseStore } from './store';

const ALERT_EVERY_SECONDS = 6 * 60 * 60; // An outage shouldn't send one email per wake.

/** Plain words for what's missing, or undefined if the server can read saved stats. Never names a key. */
export const storageProblem = () => (process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.NEXT_PUBLIC_SUPABASE_URL ? undefined : "Instagram stats aren't set up on this server yet. Ask an admin to finish the setup.");
/** The same for paid fetching. Fails closed: without a key nothing tries to run. */
export const fetchProblem = () => storageProblem() ?? (config.apifyToken ? undefined : "Instagram stats fetching isn't set up on this server yet. Ask an admin to finish the setup.");

let service: StatsService | undefined;
export function getStatsService(): StatsService {
  if (service) return service;
  const store = createSupabaseStore(createServiceRoleClient());
  service = createStatsService({
    store,
    alert: async (kind, text) => {
      try {
        const to = process.env.STATS_ALERT_EMAIL;
        if (!to || !(await store.alertDue(kind, ALERT_EVERY_SECONDS))) return;
        await sendEmail({ to, subject: 'Instagram stats need attention', html: `<p>${text}</p>`, text, relatedType: 'instagram_stats' });
      } catch (e) {
        console.error(`Could not send a stats alert: ${(e as Error).message}`);
      }
    },
  });
  return service;
}
