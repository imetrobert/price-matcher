/**
 * How a flyer page is read, and what shape the answer takes.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS SHARED
 * ---------------------------------------------------------------------------
 * Two copies existed — one in the vision function, one in the worker — and by
 * the time anybody compared them they had drifted to 3,243 and 1,940
 * characters. The worker reads every page of every flyer; the vision function
 * reads the cover to find the store and the dates. They were giving the model
 * materially different instructions for the same job, and nothing would have
 * surfaced that but reading both.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PRICE IS ASKED FOR AS TWO INTEGERS
 * ---------------------------------------------------------------------------
 * A grocery flyer sets the dollars enormous and the cents as a small
 * superscript: 4 with a raised 99 beside it. There is no decimal point on the
 * page at all, and Quebec flyers that do print one use a comma. Asking for
 * "the price" invites a model to render that as 4.99, 499, 4,99 or 4 99, and
 * one of those is a hundredfold error in a number shown to a cashier.
 *
 * Asking for the two numerals it can literally see removes the decision.
 * Assembling them into cents is arithmetic, and arithmetic is done in code.
 *
 * ---------------------------------------------------------------------------
 * WHY basis IS REQUIRED
 * ---------------------------------------------------------------------------
 * "/lb" is printed in six-point type beside a price set forty points tall. An
 * extraction that overlooks it produces a number that looks comparable to a
 * package price and is not. Required, with no default, so an omission is a
 * failure rather than a silent PER_ITEM.
 *
 * ---------------------------------------------------------------------------
 * WHY ONE TILE CAN PRODUCE SEVERAL OFFERS
 * ---------------------------------------------------------------------------
 * "Tomates en dés Aylmer 796 ml ou Sauce tomate 680 ml" is one price for
 * either of two products. Read as a single offer it stored the first product
 * and the first size, so a shopper holding the second was told their item was
 * not advertised this week — a real saving, missing, with no error and no low
 * confidence to mark it. Eight of twenty offers on one Walmart page were tiles
 * of this shape.
 *
 * The split is asked of the model rather than done afterwards with a regular
 * expression, because it needs a judgement the text alone does not carry:
 * whether "Chips Ahoy!" is a brand, whether "Casa Di Mama" belongs to Dr.
 * Oetker, whether "175 g ou 200 g" is two products or two sizes of one. The
 * model is looking at the tile. A parser splitting on the word "ou" is
 * guessing, and a guess here manufactures an offer nobody printed.
 */

export const FLYER_PROMPT =
  "You are reading one page of a Canadian grocery flyer. List EVERY advertised " +
  "product offer on the page — work across the whole page, tile by tile, and " +
  "do not stop after the first few. A full page of a Montreal grocery flyer " +
  "typically carries between ten and thirty offers; a page of this kind with " +
  "no offers at all is rare and usually means a section divider or a page of " +
  "policy text. If a page really has none, return an empty list, but check the " +
  "whole page first.\n\n" +
  "For each offer:\n" +
  "- advertisedText: the product wording exactly as printed, in the flyer's own " +
  "language. Do not translate, tidy or expand it.\n" +
  "- brand: the brand name if one is printed, otherwise null.\n" +
  "- size: the pack size as printed (\"551 mL\", \"375 g\", \"1 kg\"), otherwise null.\n" +
  "- retailerSku: the retailer's article number if the tile prints one, such as " +
  "\"N° 51087737\" — digits only, otherwise null.\n" +
  "- priceDollars and priceCents: the two numerals of the sale price exactly as " +
  "shown. A price displayed as a large 4 with a small 99 is priceDollars 4, " +
  "priceCents 99. A price shown as 44 cents is priceDollars 0, priceCents 44.\n" +
  "- basis: PER_ITEM when the price is for the item as sold (\"each\", \"chacun\", " +
  "\"le paquet\", or no unit shown), PER_LB when marked /lb, PER_KG when marked " +
  "/kg, PER_100G or PER_100ML when marked per 100 g or 100 ml. Look carefully: " +
  "the unit is printed much smaller than the price.\n" +
  "- regularDollars and regularCents: the struck-through or \"reg.\" price if the " +
  "tile prints one, otherwise null for both.\n" +
  "- regularBasis: what the REGULAR price is per, using the same values as " +
  "basis. Flyers often print a sale price per pound beside a regular price per " +
  "kilogram — read each one's own unit, do not copy the sale price's. Null " +
  "when there is no regular price.\n" +
  "- condition: UNIT_PRICE for a plain price; MULTI_BUY for \"2 for $5\"; " +
  "LOYALTY_ONLY when a card is required; LIMIT_APPLIES when a quantity limit is " +
  "printed; WITH_PURCHASE when it depends on buying something else.\n" +
  "- conditionText: the qualifying words exactly as printed (\"limite 4\", " +
  "\"2 for $5\", \"avec carte\"), otherwise null.\n\n" +
  "Also report validFrom and validTo: the dates this flyer runs, as YYYY-MM-DD, " +
  "if they are printed on this page — flyers print them as \"du 13 au 19 aout\" " +
  "or \"valid August 13 to 19\". Use ONLY the year printed on the page; if no " +
  "year is printed, return null for both rather than assuming the current one. " +
  "Return null for both if no dates appear on this page.\n\n" +
  "Also report retailerName: the name of the store whose logo or branding " +
  "appears on this page — Maxi, IGA, Walmart, Metro, Super C, Provigo — or " +
  "null if no store branding is visible. Report the brand printed on the page, " +
  "never a guess from the products.\n\n" +
  "ONE TILE CAN ADVERTISE SEVERAL PRODUCTS AT ONE PRICE. Flyers print these " +
  "as \"A ou B\", \"A or B\" or a comma-separated list: \"Tomates en dés Aylmer " +
  "796 ml ou Sauce tomate 680 ml\", \"Biscuits Grandma 6 x 43 g, Chips Ahoy! " +
  "300 g ou Barres Quaker 6 x 24 g\". Return ONE ENTRY PER PRODUCT in such a " +
  "tile, each with its own advertisedText, its own brand and its own size, all " +
  "sharing the tile's price, basis and condition. Somebody holding the second " +
  "product is owed the same price as somebody holding the first.\n\n" +
  "Two things this rule is NOT:\n" +
  "- A tile offering one product in alternative SIZES (\"Macaroni au fromage " +
  "Kraft 175 g ou 200 g\", \"Légumes Green Giant 300 g à 500 g\") is ONE " +
  "product. Return one entry, with the first size printed.\n" +
  "- A tile listing flavours or varieties of one product (\"cheddar fort, moyen " +
  "ou doux 400 g\") is ONE product. Return one entry.\n" +
  "Split only when each part names a product that could be bought on its own, " +
  "with its own size printed. If you are unsure, return one entry — a single " +
  "correct offer is worth more than two uncertain ones.\n\n" +

  "- box: where the offer's tile sits on the page, as four whole numbers " +
  "[ymin, xmin, ymax, xmax] on a 0-1000 scale with 0,0 at the TOP-LEFT " +
  "corner. Give the box around the whole tile — the picture, the product " +
  "wording and the price together — not just the price. Omit box entirely " +
  "if you are not confident where the tile is; a missing box costs nothing " +
  "and a wrong one points somebody at the wrong product.\n\n" +
  "Report only what is printed on this page. If you cannot read a price " +
  "clearly, omit that offer entirely rather than guessing at it. Do not infer a " +
  "price from a similar product elsewhere on the page.";

export const FLYER_SCHEMA = {
  type: "object",
  properties: {
    retailerName: { type: "string", nullable: true },
    validFrom: { type: "string", nullable: true },
    validTo: { type: "string", nullable: true },
    offers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          advertisedText: { type: "string" },
          brand: { type: "string", nullable: true },
          size: { type: "string", nullable: true },
          retailerSku: { type: "string", nullable: true },
          priceDollars: { type: "integer" },
          priceCents: { type: "integer" },
          basis: {
            type: "string",
            enum: ["PER_ITEM", "PER_LB", "PER_KG", "PER_100G", "PER_100ML"],
          },
          regularDollars: { type: "integer", nullable: true },
          regularCents: { type: "integer", nullable: true },
          regularBasis: {
            type: "string",
            nullable: true,
            enum: ["PER_ITEM", "PER_LB", "PER_KG", "PER_100G", "PER_100ML"],
          },
          condition: {
            type: "string",
            enum: [
              "UNIT_PRICE",
              "MULTI_BUY",
              "LOYALTY_ONLY",
              "LIMIT_APPLIES",
              "WITH_PURCHASE",
            ],
          },
          conditionText: { type: "string", nullable: true },
          box: {
            type: "array",
            nullable: true,
            items: { type: "integer" },
          },
        },
        required: [
          "advertisedText",
          "priceDollars",
          "priceCents",
          "basis",
          "condition",
        ],
      },
    },
  },
  required: ["offers"],
} as const;
