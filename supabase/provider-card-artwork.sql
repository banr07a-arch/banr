do $migration$
declare definition text;
begin
 select pg_get_functiondef('banr_private.username_admin_action(text,jsonb)'::regprocedure) into definition;
 if strpos(definition,'''providerBanner''')=0 then
  if strpos(definition,'''hero'',''about''')=0 then raise exception 'Existing patient content allowlist could not be located.'; end if;
  execute replace(definition,'''hero'',''about''','''hero'',''about'',''providerBanner''');
 end if;
end $migration$;