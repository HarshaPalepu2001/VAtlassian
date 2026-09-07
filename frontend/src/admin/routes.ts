export const ADMIN_ROUTES=['admins','roles','transitions','fields','ledger','retention','content-review','credentials','health'] as const;
export type AdminRoute=typeof ADMIN_ROUTES[number];
export function parseAdminRoute(pathname:string):AdminRoute|null{const route=pathname.replace(/^\/+|\/+$/g,'')||'admins';return ADMIN_ROUTES.includes(route as AdminRoute)?route as AdminRoute:null;}
