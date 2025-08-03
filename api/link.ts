import { createClient } from "@supabase/supabase-js";
import { waitUntil } from "@vercel/functions";
import type { VercelRequest, VercelResponse } from "@vercel/node";

async function getLink(supabase: any, url: string) {
  const { data: existingLinkData, error: existingLinkError } = await supabase
    .from("links")
    .select()
    .eq("url", url);
  if (existingLinkError) {
    throw new Error(existingLinkError.message);
  }

  if (existingLinkData && existingLinkData.length > 0) {
    return existingLinkData[0];
  }

  const { data: linkData, error: errorData } = await supabase
    .from("links")
    .insert({ url })
    .select();
  if (errorData) {
    throw new Error(errorData.message);
  }

  return linkData[0];
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") {
    return res.status(200).json({});
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: "URL is required" });
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_KEY!,
      {
        global: {
          headers: { Authorization: req.headers["authorization"]! as string },
        },
      },
    );

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const link = await getLink(supabase, url);

    const { data: userLinkData, error: userLinkError } = await supabase
      .from("user_links")
      .insert({ link_id: link.id, user_id: user.id })
      .select()
      .single();
    if (userLinkError) {
      throw new Error(userLinkError.message);
    }

    waitUntil(
      (async () => {
        try {
          const { data: existingTags, error: existingTagsError } =
            await supabase.from("tags").select().eq("user_id", user.id);
          if (existingTagsError) {
            throw new Error(existingTagsError.message);
          }

          const res = await fetch(`${process.env.PEWTERFELT_AI_URL!}/api/tag`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.PEWTERFELT_AI_KEY!}`,
            },
            body: JSON.stringify({
              url,
              tags: existingTags?.length
                ? existingTags.map((tag) => tag.text)
                : [],
            }),
          }).then((res) => res.json());
          if (res.detail) {
            throw new Error(res.detail);
          }

          const {
            tags: generatedTags,
            metadata: { favicon, meta_image, title },
            content,
          } = res;

          if (content) {
            const { error: userLinkError } = await supabase
              .from("user_links")
              .update({ content })
              .eq("id", userLinkData.id);
            if (userLinkError) {
              throw new Error(userLinkError.message);
            }
          }

          if (generatedTags && generatedTags.length > 0) {
            const { data: matchingTags, error: existingTagsError } =
              await supabase
                .from("tags")
                .select()
                .eq("user_id", user.id)
                .in("text", generatedTags);
            if (existingTagsError) {
              throw new Error(existingTagsError.message);
            }

            const existingTagTexts = matchingTags.map((tag) => tag.text);
            const newTags = generatedTags.filter(
              (text: string) => !existingTagTexts.includes(text),
            );

            let allTags = [...matchingTags];
            if (newTags.length > 0) {
              const { data: insertedTags, error: tagsError } = await supabase
                .from("tags")
                .insert(
                  newTags.map((text: string) => ({ user_id: user.id, text })),
                )
                .select();
              if (tagsError) {
                throw new Error(tagsError.message);
              }
              allTags = [...allTags, ...insertedTags];
            }

            const { error: userLinkTagsError } = await supabase
              .from("user_link_tags")
              .insert(
                allTags.map((tag) => ({
                  user_link_id: userLinkData.id,
                  tag_id: tag.id,
                })),
              );
            if (userLinkTagsError) {
              throw new Error(userLinkTagsError.message);
            }
          }

          const { error: updateError } = await supabase
            .from("links")
            .update({
              favicon: favicon ?? null,
              thumbnail: meta_image ?? null,
              title: title ?? null,
            })
            .eq("url", url);
          if (updateError) {
            throw new Error(updateError.message);
          }
        } catch (error) {
          console.error("Error processing link metadata:", error);
        }
      })(),
    );

    return res.status(200).json({});
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
