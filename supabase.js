import { createClient } from "@supabase/supabase-js";

console.log("Supabase file loaded");

export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);
