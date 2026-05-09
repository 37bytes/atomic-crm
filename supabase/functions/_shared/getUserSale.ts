import { type AuthenticatedUser } from "./authentication.ts";
import { supabaseAdmin } from "./supabaseAdmin.ts";

/**
 * Get the sale associated to the provided user.
 */
export const getUserSale = async (user: AuthenticatedUser) => {
  return (
    await supabaseAdmin
      .from("sales")
      .select("*")
      .eq("user_id", user.id)
      .single()
  )?.data;
};
