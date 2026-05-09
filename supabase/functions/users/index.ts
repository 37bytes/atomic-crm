import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, OptionsMiddleware } from "../_shared/cors.ts";
import { createErrorResponse } from "../_shared/utils.ts";
import { AuthMiddleware, UserMiddleware } from "../_shared/authentication.ts";
import { getUserSale } from "../_shared/getUserSale.ts";

async function updateSaleDisabled(user_id: string, disabled: boolean) {
  return await supabaseAdmin
    .from("sales")
    .update({ disabled: disabled ?? false })
    .eq("user_id", user_id);
}

async function updateSaleAdministrator(
  user_id: string,
  administrator: boolean,
) {
  const { data: sales, error: salesError } = await supabaseAdmin
    .from("sales")
    .update({ administrator })
    .eq("user_id", user_id)
    .select("*");

  if (!sales?.length || salesError) {
    console.error("Error updating user:", salesError);
    throw salesError ?? new Error("Failed to update sale");
  }
  return sales.at(0);
}

async function createSale(
  user_id: string,
  data: {
    email: string;
    first_name: string;
    last_name: string;
    disabled: boolean;
    administrator: boolean;
  },
) {
  const { data: sales, error: salesError } = await supabaseAdmin
    .from("sales")
    .insert({ ...data, user_id })
    .select("*");

  if (!sales?.length || salesError) {
    console.error("Error creating user:", salesError);
    throw salesError ?? new Error("Failed to create sale");
  }
  return sales.at(0);
}

async function getOrCreateSale(
  user_id: string,
  data: {
    email: string;
    first_name: string;
    last_name: string;
    disabled: boolean;
    administrator: boolean;
  },
) {
  const { data: sales, error: salesError } = await supabaseAdmin
    .from("sales")
    .select("*")
    .eq("user_id", user_id);

  if (salesError) {
    console.error("Error fetching sale:", salesError);
    throw salesError;
  }

  if (sales.length > 0) {
    return sales.at(0);
  }

  return createSale(user_id, data);
}

async function updateSaleAvatar(user_id: string, avatar: string) {
  const { data: sales, error: salesError } = await supabaseAdmin
    .from("sales")
    .update({ avatar })
    .eq("user_id", user_id)
    .select("*");

  if (!sales?.length || salesError) {
    console.error("Error updating user:", salesError);
    throw salesError ?? new Error("Failed to update sale");
  }
  return sales.at(0);
}

async function inviteUser(req: Request, currentUserSale: any) {
  const { email, first_name, last_name, disabled, administrator } =
    await req.json();

  if (!currentUserSale.administrator) {
    return createErrorResponse(401, "Not Authorized");
  }

  const { data, error: userError } = await supabaseAdmin.auth.admin.createUser({
    email,
    email_confirm: true,
    password: crypto.randomUUID() + crypto.randomUUID(),
    user_metadata: { first_name, last_name },
  });

  let user = data?.user;

  if (!user && userError?.code === "email_exists") {
    // This may happen if users cleared their database but not the users
    // We have to create the sale directly
    const { data, error } = await supabaseAdmin.rpc("get_user_id_by_email", {
      email,
    });

    if (!data || error) {
      console.error(
        `Error inviting user: error=${error ?? "could not fetch users for email"}`,
      );
      return createErrorResponse(500, "Internal Server Error");
    }

    user = data[0];
    try {
      const { data: existingSale, error: salesError } = await supabaseAdmin
        .from("sales")
        .select("*")
        .eq("user_id", user.id);
      if (salesError) {
        return createErrorResponse(salesError.status, salesError.message, {
          code: salesError.code,
        });
      }
      if (existingSale.length > 0) {
        return createErrorResponse(
          400,
          "A sales for this email already exists",
        );
      }

      const sale = await createSale(user.id, {
        email,
        first_name,
        last_name,
        disabled,
        administrator,
      });

      return new Response(
        JSON.stringify({
          data: sale,
        }),
        {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        },
      );
    } catch (error) {
      return createErrorResponse(
        (error as any).status ?? 500,
        (error as Error).message,
        {
          code: (error as any).code,
        },
      );
    }
  } else {
    if (userError) {
      console.error(`Error inviting user: user_error=${userError}`);
      return createErrorResponse(userError.status, userError.message, {
        code: userError.code,
      });
    }
    if (!data?.user) {
      console.error("Error inviting user: undefined user");
      return createErrorResponse(500, "Internal Server Error");
    }
    // Email/password auth is optional and may be disabled. Create the auth user
    // and sales profile only; SSO users will sign in through the configured IdP.
  }

  try {
    await getOrCreateSale(user.id, {
      email,
      first_name,
      last_name,
      disabled,
      administrator,
    });
    await updateSaleDisabled(user.id, disabled);
    const sale = await updateSaleAdministrator(user.id, administrator);

    return new Response(
      JSON.stringify({
        data: sale,
      }),
      {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  } catch (e) {
    console.error("Error patching sale:", e);
    return createErrorResponse(500, "Internal Server Error");
  }
}

async function countSaleReferences(table: string, sales_id: number) {
  const { count, error } = await supabaseAdmin
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("sales_id", sales_id);

  if (error) {
    console.error(`Error counting ${table} references:`, error);
    throw error;
  }

  return count ?? 0;
}

async function deleteUser(req: Request, currentUserSale: any) {
  const { sales_id } = await req.json();

  if (!currentUserSale.administrator) {
    return createErrorResponse(401, "Not Authorized");
  }

  const { data: sale, error: saleError } = await supabaseAdmin
    .from("sales")
    .select("*")
    .eq("id", sales_id)
    .single();

  if (saleError || !sale) {
    return createErrorResponse(404, "Not Found");
  }

  if (
    sale.id === currentUserSale.id ||
    sale.user_id === currentUserSale.user_id
  ) {
    return createErrorResponse(400, "You cannot delete your own user");
  }

  try {
    const relatedCounts = await Promise.all(
      [
        "companies",
        "contacts",
        "contact_notes",
        "deals",
        "deal_notes",
        "tasks",
      ].map(async (table) => ({
        table,
        count: await countSaleReferences(table, sales_id),
      })),
    );
    const relatedRecords = relatedCounts.filter(({ count }) => count > 0);

    if (relatedRecords.length > 0) {
      return createErrorResponse(
        409,
        "Cannot delete a user with related CRM records. Disable the user instead.",
        { relatedRecords },
      );
    }

    const { error: banError } = await supabaseAdmin.auth.admin.updateUserById(
      sale.user_id,
      { ban_duration: "87600h" },
    );

    if (banError) {
      console.error("Error banning auth user before deletion:", banError);
      return createErrorResponse(banError.status, banError.message, {
        code: banError.code,
      });
    }

    const { error: salesError } = await supabaseAdmin
      .from("sales")
      .delete()
      .eq("id", sale.id);

    if (salesError) {
      console.error("Error deleting sale:", salesError);
      await supabaseAdmin.auth.admin
        .updateUserById(sale.user_id, { ban_duration: "none" })
        .catch((unbanError) => {
          console.error(
            "Error unbanning auth user after sales delete failure:",
            unbanError,
          );
        });
      return createErrorResponse(salesError.status, salesError.message, {
        code: salesError.code,
      });
    }

    const { error: userError } = await supabaseAdmin.auth.admin.deleteUser(
      sale.user_id,
    );

    if (userError) {
      console.error("Error deleting auth user:", userError);
      await createSale(sale.user_id, {
        email: sale.email,
        first_name: sale.first_name,
        last_name: sale.last_name,
        disabled: true,
        administrator: sale.administrator,
      }).catch((restoreError) => {
        console.error(
          "Error restoring sale after auth delete failure:",
          restoreError,
        );
      });
      return createErrorResponse(userError.status, userError.message, {
        code: userError.code,
      });
    }

    return new Response(JSON.stringify({ data: sale }), {
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (e) {
    console.error("Error deleting user:", e);
    return createErrorResponse(500, "Internal Server Error");
  }
}

async function patchUser(req: Request, currentUserSale: any) {
  const {
    sales_id,
    email,
    first_name,
    last_name,
    avatar,
    administrator,
    disabled,
  } = await req.json();
  const { data: sale } = await supabaseAdmin
    .from("sales")
    .select("*")
    .eq("id", sales_id)
    .single();

  if (!sale) {
    return createErrorResponse(404, "Not Found");
  }

  // Users can only update their own profile unless they are an administrator
  if (!currentUserSale.administrator && currentUserSale.id !== sale.id) {
    return createErrorResponse(401, "Not Authorized");
  }

  const { data, error: userError } =
    await supabaseAdmin.auth.admin.updateUserById(sale.user_id, {
      email,
      ban_duration: disabled ? "87600h" : "none",
      user_metadata: { first_name, last_name },
    });

  if (!data?.user || userError) {
    console.error("Error patching user:", userError);
    return createErrorResponse(500, "Internal Server Error");
  }

  if (avatar) {
    await updateSaleAvatar(data.user.id, avatar);
  }

  // Only administrators can update the administrator and disabled status
  if (!currentUserSale.administrator) {
    const { data: new_sale } = await supabaseAdmin
      .from("sales")
      .select("*")
      .eq("id", sales_id)
      .single();
    return new Response(
      JSON.stringify({
        data: new_sale,
      }),
      {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      },
    );
  }

  try {
    await updateSaleDisabled(data.user.id, disabled);
    const sale = await updateSaleAdministrator(data.user.id, administrator);
    return new Response(
      JSON.stringify({
        data: sale,
      }),
      {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      },
    );
  } catch (e) {
    console.error("Error patching sale:", e);
    return createErrorResponse(500, "Internal Server Error");
  }
}

Deno.serve(async (req: Request) =>
  OptionsMiddleware(req, async (req) =>
    AuthMiddleware(req, async (req) =>
      UserMiddleware(req, async (req, user) => {
        const currentUserSale = await getUserSale(user);
        if (!currentUserSale) {
          return createErrorResponse(401, "Unauthorized");
        }

        if (req.method === "POST") {
          return inviteUser(req, currentUserSale);
        }

        if (req.method === "PATCH") {
          return patchUser(req, currentUserSale);
        }

        if (req.method === "DELETE") {
          return deleteUser(req, currentUserSale);
        }

        return createErrorResponse(405, "Method Not Allowed");
      }),
    ),
  ),
);
