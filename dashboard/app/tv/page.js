import TvScreen from "./TvScreen";
import { getLive } from "@/lib/snapshot";
export const dynamic = "force-dynamic";
export const metadata = { title: "Mount Coffee Solar – control room" };
export default async function Page() {
  return <TvScreen initial={await getLive()} />;
}
