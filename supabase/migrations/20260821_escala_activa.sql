-- FEATURE: Escala activa (self-service dto dinámico en 1ª compra)
-- Aplicar en el proyecto Supabase de Tierra Nativa (zjvpzqhbekxnwxdczpof)

-- 1. Columna nueva en customers
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS escala_activa boolean NOT NULL DEFAULT false;

-- 2. RPC para fijar el dto y apagar la escala atómicamente
CREATE OR REPLACE FUNCTION public.fijar_dto_escala(p_customer_id uuid, p_dto numeric)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Solo el propio cliente o un admin pueden fijar
  IF NOT EXISTS (
    SELECT 1 FROM customers c
    WHERE c.id = p_customer_id
      AND c.escala_activa = true
      AND (c.auth_user_id = auth.uid()
           OR EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()))
  ) THEN
    RAISE EXCEPTION 'no autorizado o escala no activa';
  END IF;

  UPDATE customers
    SET dto_vol = p_dto,
        escala_activa = false
  WHERE id = p_customer_id;
END;
$$;

-- Revocar acceso público (anon hereda de PUBLIC → sin esto cualquiera la llama)
REVOKE EXECUTE ON FUNCTION public.fijar_dto_escala(uuid, numeric) FROM public;
GRANT EXECUTE ON FUNCTION public.fijar_dto_escala(uuid, numeric) TO authenticated, service_role;

-- 3. Tabla de tramos (si no existe — verificar si el módulo Expo ya la creó)
-- Si ya existe expo_dto_escala, no hace falta crearla.
CREATE TABLE IF NOT EXISTS public.expo_dto_escala (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  desde numeric NOT NULL,  -- subtotal de lista desde el cual aplica
  dto   numeric NOT NULL,  -- fracción 0..1
  creado_at timestamptz DEFAULT now()
);
ALTER TABLE public.expo_dto_escala ENABLE ROW LEVEL SECURITY;

-- Policies (idempotente con IF NOT EXISTS via DO block)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'expo_escala_read' AND tablename = 'expo_dto_escala') THEN
    CREATE POLICY expo_escala_read ON public.expo_dto_escala FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'expo_escala_admin' AND tablename = 'expo_dto_escala') THEN
    CREATE POLICY expo_escala_admin ON public.expo_dto_escala FOR ALL
      USING (EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()))
      WITH CHECK (EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()));
  END IF;
END;
$$;

-- 4. Escala por LISTA
-- La tabla la comparten el módulo Expo y la escala activa. Cada tramo lleva la
-- lista a la que aplica: el pricing (getPriceForCustomer) y la escala usan la
-- misma lista del cliente. Mismos umbrales de plata, distinto techo:
--   lista 2 → tope 25% · lista 1 → tope 12%
ALTER TABLE public.expo_dto_escala
  ADD COLUMN IF NOT EXISTS lista int NOT NULL DEFAULT 2;

-- LISTA 2 (clientes de expo / lista 2) — tope 25%
DELETE FROM public.expo_dto_escala WHERE lista = 2;
INSERT INTO public.expo_dto_escala (desde, dto, lista) VALUES
  (0::numeric,       0::numeric,    2),
  (1000000::numeric, 0.05::numeric, 2),
  (2000000::numeric, 0.10::numeric, 2),
  (3500000::numeric, 0.15::numeric, 2),
  (5500000::numeric, 0.20::numeric, 2),
  (8000000::numeric, 0.25::numeric, 2);

-- LISTA 1 — mismos umbrales, tope 12%
DELETE FROM public.expo_dto_escala WHERE lista = 1;
INSERT INTO public.expo_dto_escala (desde, dto, lista) VALUES
  (0::numeric,       0::numeric,    1),
  (1000000::numeric, 0.03::numeric, 1),
  (2000000::numeric, 0.05::numeric, 1),
  (3500000::numeric, 0.08::numeric, 1),
  (5500000::numeric, 0.10::numeric, 1),
  (8000000::numeric, 0.12::numeric, 1);
