create extension if not exists http with schema extensions;

create or replace function public.cpanel_email_uapi(operation text, params jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  base_url text;
  username text;
  api_token text;
  query_string text;
  request extensions.http_request;
  response extensions.http_response;
begin
  if operation not in ('list_pops', 'add_pop', 'delete_pop') then
    raise exception 'Operação cPanel não permitida';
  end if;

  select
    max(decrypted_secret) filter (where name = 'cpanel_base_url'),
    max(decrypted_secret) filter (where name = 'cpanel_username'),
    max(decrypted_secret) filter (where name = 'cpanel_api_token')
  into base_url, username, api_token
  from vault.decrypted_secrets
  where name in ('cpanel_base_url', 'cpanel_username', 'cpanel_api_token');

  if base_url is null or username is null or api_token is null then
    raise exception 'Configuração do cPanel ausente no Vault';
  end if;
  if base_url !~ '^https://' then
    raise exception 'A URL do cPanel deve usar HTTPS';
  end if;

  select string_agg(extensions.urlencode(key) || '=' || extensions.urlencode(value), '&' order by key)
  into query_string
  from jsonb_each_text(coalesce(params, '{}'::jsonb));

  perform extensions.http_set_curlopt('CURLOPT_CONNECTTIMEOUT_MS', '5000');
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '12000');

  request := (
    'GET',
    rtrim(base_url, '/') || '/execute/Email/' || operation ||
      case when coalesce(query_string, '') = '' then '' else '?' || query_string end,
    array[
      row('Authorization', 'cpanel ' || username || ':' || api_token)::extensions.http_header,
      row('Accept', 'application/json')::extensions.http_header,
      row('User-Agent', 'Enterpriser-CRM/1.0')::extensions.http_header
    ],
    null,
    null
  )::extensions.http_request;

  select * into response from extensions.http(request);

  if response.status < 200 or response.status >= 300 then
    return jsonb_build_object(
      'status', 0,
      'errors', jsonb_build_array('HostGator respondeu HTTP ' || response.status)
    );
  end if;
  return response.content::jsonb;
end;
$$;

revoke all on function public.cpanel_email_uapi(text, jsonb) from public, anon, authenticated;
grant execute on function public.cpanel_email_uapi(text, jsonb) to service_role;
