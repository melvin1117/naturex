/** Friendly aliases for generated schema types (from schema.d.ts; never hand-edit that). */
import type { components } from "./schema";

type Schemas = components["schemas"];

export type AssetCard = Schemas["AssetCard"];
export type AssetDetail = Schemas["AssetDetail"];
export type HoldingOut = Schemas["HoldingOut"];
export type LoginIn = Schemas["LoginIn"];
export type MeOut = Schemas["MeOut"];
export type OrderCreate = Schemas["OrderCreate"];
export type OrderOut = Schemas["OrderOut"];
export type Persona = Schemas["PersonaOut"];
export type PortfolioOut = Schemas["PortfolioOut"];
export type QuoteOut = Schemas["QuoteOut"];
export type RegisterIn = Schemas["RegisterIn"];
export type ReportOut = Schemas["ReportOut"];
export type StreamEvent = Schemas["StreamEvent"];
export type StreamEventType = Schemas["StreamEventType"];
export type WorldAsset = Schemas["WorldAssetOut"];
export type WorldOut = Schemas["WorldOut"];
