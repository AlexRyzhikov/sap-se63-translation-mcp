"! SAPscript long texts for the MCP translation service.
"!   R3TR FORM <form>            SE71 form (texts of all windows)
"!   R3TR TEXT <name>[,<id>]     SO10 standard text (TDOBJECT TEXT, default ID ST)
"!
"! In SE63 these are long texts, not text pairs. So we split the text lines into
"! segments (one paragraph = one segment), Claude translates the segments, and we
"! build the lines again (max. 132 characters, SAPscript continuation formats).
"! Command lines (/:), comments (/*), windows (/W) and text elements (/E) are kept
"! unchanged, so the logic of the form stays the same in every language.
"!
"! APIs: READ_FORM / SAVE_FORM (SE71), READ_TEXT / SAVE_TEXT (SO10).
CLASS zcl_mcp_transl_sapscript DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    TYPES:
      tt_tline TYPE STANDARD TABLE OF tline WITH EMPTY KEY,

      "! One translatable unit (as seen by the API class / the MCP worklist)
      BEGIN OF ty_pair,
        textkey  TYPE string,
        texttype TYPE string,
        source   TYPE string,
        target   TYPE string,
      END OF ty_pair,
      tt_pair TYPE STANDARD TABLE OF ty_pair WITH EMPTY KEY,

      BEGIN OF ty_result,
        textkey TYPE string,
        result  TYPE string,
        message TYPE string,
      END OF ty_result,
      tt_result TYPE STANDARD TABLE OF ty_result WITH EMPTY KEY,

      "! kind: T = text paragraph (translatable), K = keep lines unchanged
      BEGIN OF ty_seg,
        kind     TYPE c LENGTH 1,
        window   TYPE string,
        textkey  TYPE string,
        texttype TYPE string,
        format   TYPE tdformat,
        text     TYPE string,
        done     TYPE abap_bool,   " text is already in the target language
        lines    TYPE tt_tline,    " original lines of this segment
      END OF ty_seg,
      tt_seg TYPE STANDARD TABLE OF ty_seg WITH EMPTY KEY.

    CONSTANTS c_line_len TYPE i VALUE 132.

    CLASS-METHODS is_sapscript
      IMPORTING iv_object     TYPE csequence
      RETURNING VALUE(rv_yes) TYPE abap_bool.

    "! TEXT: 'ZNAME' / 'ZNAME,ST' / transport key 'TEXT,ZNAME,ST,E' -> 'ZNAME,ST'.
    "! Returns initial for a transport key of another text object (not TEXT).
    CLASS-METHODS normalize_name
      IMPORTING iv_object      TYPE csequence
                iv_name        TYPE csequence
      RETURNING VALUE(rv_name) TYPE sobj_name.

    METHODS exists
      IMPORTING iv_object     TYPE csequence
                iv_name       TYPE csequence
      RETURNING VALUE(rv_yes) TYPE abap_bool.

    "! Original language (FORM: TADIR, TEXT: STXH-TDOSPRAS). Initial if unknown.
    METHODS orig_lang
      IMPORTING iv_object       TYPE csequence
                iv_name         TYPE csequence
      RETURNING VALUE(rv_spras) TYPE spras.

    METHODS has_language
      IMPORTING iv_object     TYPE csequence
                iv_name       TYPE csequence
                iv_spras      TYPE spras
      RETURNING VALUE(rv_yes) TYPE abap_bool.

    METHODS read_pairs
      IMPORTING iv_object   TYPE csequence
                iv_name     TYPE csequence
                iv_s_lang   TYPE spras
                iv_t_lang   TYPE spras
      EXPORTING et_pairs    TYPE tt_pair
                et_messages TYPE string_table
      RAISING   zcx_mcp_transl.

    "! Writes the target language version. Segments without a proposal keep the
    "! existing translation, or the source text if there is none yet.
    "! es_e071 = transport entry for the written language version.
    METHODS write_pairs
      IMPORTING iv_object   TYPE csequence
                iv_name     TYPE csequence
                iv_s_lang   TYPE spras
                iv_t_lang   TYPE spras
                it_pairs    TYPE tt_pair
                iv_dry_run  TYPE abap_bool
      EXPORTING et_results  TYPE tt_result
                es_e071     TYPE e071
                et_messages TYPE string_table
      RAISING   zcx_mcp_transl.

    "! Public for unit tests: split lines / build lines again.
    METHODS segments
      IMPORTING it_lines      TYPE tt_tline
      RETURNING VALUE(rt_seg) TYPE tt_seg.

    METHODS rebuild
      IMPORTING it_seg          TYPE tt_seg
      RETURNING VALUE(rt_lines) TYPE tt_tline.

    METHODS wrap
      IMPORTING iv_text         TYPE string
                iv_format       TYPE tdformat
      RETURNING VALUE(rt_lines) TYPE tt_tline.

    METHODS has_words
      IMPORTING iv_text       TYPE string
      RETURNING VALUE(rv_yes) TYPE abap_bool.

  PROTECTED SECTION.
  PRIVATE SECTION.
    TYPES:
      BEGIN OF ty_form,
        header       TYPE itcta,
        lines        TYPE tt_tline,
        pages        TYPE STANDARD TABLE OF itctg WITH EMPTY KEY,
        page_windows TYPE STANDARD TABLE OF itcth WITH EMPTY KEY,
        paragraphs   TYPE STANDARD TABLE OF itcdp WITH EMPTY KEY,
        strings      TYPE STANDARD TABLE OF itcds WITH EMPTY KEY,
        tabs         TYPE STANDARD TABLE OF itcdq WITH EMPTY KEY,
        windows      TYPE STANDARD TABLE OF itctw WITH EMPTY KEY,
      END OF ty_form.

    METHODS split_text_name
      IMPORTING iv_name   TYPE csequence
      EXPORTING ev_tdname TYPE tdobname
                ev_tdid   TYPE tdid.

    METHODS read_form
      IMPORTING iv_form  TYPE csequence
                iv_spras TYPE spras
      EXPORTING ev_found TYPE abap_bool
                es_form  TYPE ty_form
      RAISING   zcx_mcp_transl.

    METHODS read_std_text
      IMPORTING iv_name   TYPE csequence
                iv_spras  TYPE spras
      EXPORTING ev_found  TYPE abap_bool
                es_header TYPE thead
                et_lines  TYPE tt_tline.

    METHODS get_lines
      IMPORTING iv_object TYPE csequence
                iv_name   TYPE csequence
                iv_spras  TYPE spras
      EXPORTING ev_found  TYPE abap_bool
                et_lines  TYPE tt_tline
      RAISING   zcx_mcp_transl.

    "! True if both segment lists have the same translatable keys in the same order
    METHODS same_structure
      IMPORTING it_a        TYPE tt_seg
                it_b        TYPE tt_seg
      RETURNING VALUE(rv_yes) TYPE abap_bool.

ENDCLASS.



CLASS zcl_mcp_transl_sapscript IMPLEMENTATION.

  METHOD is_sapscript.
    rv_yes = xsdbool( iv_object = 'FORM' OR iv_object = 'TEXT' ).
  ENDMETHOD.


  METHOD normalize_name.
    rv_name = to_upper( condense( iv_name ) ).
    IF iv_object <> 'TEXT'.
      RETURN.
    ENDIF.

    SPLIT rv_name AT ',' INTO TABLE DATA(lt_parts).
    CASE lines( lt_parts ).
      WHEN 1.
        rv_name = |{ lt_parts[ 1 ] },ST|.
      WHEN 2.
        rv_name = |{ lt_parts[ 1 ] },{ lt_parts[ 2 ] }|.
      WHEN OTHERS.                      " transport key TEXT,<name>,<id>,<lang>
        IF lt_parts[ 1 ] = `TEXT` AND lines( lt_parts ) >= 3.
          rv_name = |{ lt_parts[ 2 ] },{ lt_parts[ 3 ] }|.
        ELSE.
          CLEAR rv_name.
        ENDIF.
    ENDCASE.
  ENDMETHOD.


  METHOD split_text_name.
    DATA(lv_name) = normalize_name( iv_object = 'TEXT' iv_name = iv_name ).
    SPLIT lv_name AT ',' INTO ev_tdname ev_tdid.
    IF ev_tdid IS INITIAL.
      ev_tdid = 'ST'.
    ENDIF.
  ENDMETHOD.


  METHOD exists.
    DATA lv_tdname TYPE tdobname.
    DATA lv_tdid   TYPE tdid.

    CASE iv_object.
      WHEN 'FORM'.
        lv_tdname = to_upper( iv_name ).
        SELECT SINGLE @abap_true FROM stxh
          WHERE tdobject = 'FORM' AND tdname = @lv_tdname
          INTO @rv_yes.
        IF rv_yes = abap_false.
          DATA(lv_lang) = orig_lang( iv_object = iv_object iv_name = iv_name ).
          TRY.
              read_form( EXPORTING iv_form  = iv_name
                                   iv_spras = COND #( WHEN lv_lang IS NOT INITIAL THEN lv_lang ELSE sy-langu )
                         IMPORTING ev_found = rv_yes ).
            CATCH zcx_mcp_transl.
              rv_yes = abap_false.
          ENDTRY.
        ENDIF.

      WHEN 'TEXT'.
        split_text_name( EXPORTING iv_name = iv_name IMPORTING ev_tdname = lv_tdname ev_tdid = lv_tdid ).
        SELECT SINGLE @abap_true FROM stxh
          WHERE tdobject = 'TEXT' AND tdname = @lv_tdname AND tdid = @lv_tdid
          INTO @rv_yes.
    ENDCASE.
  ENDMETHOD.


  METHOD orig_lang.
    DATA lv_tdname TYPE tdobname.
    DATA lv_tdid   TYPE tdid.
    DATA lt_langs  TYPE STANDARD TABLE OF spras WITH EMPTY KEY.

    CASE iv_object.
      WHEN 'FORM'.
        DATA(lv_obj_name) = CONV sobj_name( to_upper( iv_name ) ).
        SELECT SINGLE masterlang FROM tadir
          WHERE pgmid = 'R3TR' AND object = 'FORM' AND obj_name = @lv_obj_name
          INTO @rv_spras.
        IF rv_spras IS INITIAL.
          lv_tdname = lv_obj_name.
          SELECT SINGLE tdospras FROM stxh
            WHERE tdobject = 'FORM' AND tdname = @lv_tdname AND tdospras <> @space
            INTO @rv_spras.
        ENDIF.

      WHEN 'TEXT'.
        split_text_name( EXPORTING iv_name = iv_name IMPORTING ev_tdname = lv_tdname ev_tdid = lv_tdid ).
        SELECT SINGLE tdospras FROM stxh
          WHERE tdobject = 'TEXT' AND tdname = @lv_tdname AND tdid = @lv_tdid AND tdospras <> @space
          INTO @rv_spras.
        IF rv_spras IS INITIAL.
          " no original language stored: only clear if the text exists in one language
          SELECT tdspras FROM stxh
            WHERE tdobject = 'TEXT' AND tdname = @lv_tdname AND tdid = @lv_tdid
            INTO TABLE @lt_langs.
          IF lines( lt_langs ) = 1.
            rv_spras = lt_langs[ 1 ].
          ENDIF.
        ENDIF.
    ENDCASE.
  ENDMETHOD.


  METHOD has_language.
    DATA lv_tdname TYPE tdobname.
    DATA lv_tdid   TYPE tdid.

    CASE iv_object.
      WHEN 'FORM'.
        TRY.
            read_form( EXPORTING iv_form = iv_name iv_spras = iv_spras IMPORTING ev_found = rv_yes ).
          CATCH zcx_mcp_transl.
            rv_yes = abap_false.
        ENDTRY.
      WHEN 'TEXT'.
        split_text_name( EXPORTING iv_name = iv_name IMPORTING ev_tdname = lv_tdname ev_tdid = lv_tdid ).
        SELECT SINGLE @abap_true FROM stxh
          WHERE tdobject = 'TEXT' AND tdname = @lv_tdname AND tdid = @lv_tdid AND tdspras = @iv_spras
          INTO @rv_yes.
    ENDCASE.
  ENDMETHOD.


  METHOD read_form.
    DATA lv_form  TYPE itcta-tdform.
    DATA lv_found TYPE c LENGTH 1.

    CLEAR: ev_found, es_form.
    lv_form = to_upper( iv_form ).

    TRY.
        CALL FUNCTION 'READ_FORM'
          EXPORTING
            form         = lv_form
            language     = iv_spras
          IMPORTING
            form_header  = es_form-header
            found        = lv_found
          TABLES
            form_lines   = es_form-lines
            pages        = es_form-pages
            page_windows = es_form-page_windows
            paragraphs   = es_form-paragraphs
            strings      = es_form-strings
            tabs         = es_form-tabs
            windows      = es_form-windows
          EXCEPTIONS
            OTHERS       = 1.
      CATCH cx_sy_dyn_call_error INTO DATA(lx_call).
        RAISE EXCEPTION TYPE zcx_mcp_transl
          EXPORTING iv_text = |READ_FORM: { lx_call->get_text( ) }| iv_http_status = 500.
    ENDTRY.

    ev_found = xsdbool( sy-subrc = 0 AND lv_found IS NOT INITIAL ).

    " READ_FORM must not give us another language (fallback) as "found"
    IF ev_found = abap_true.
      ASSIGN COMPONENT 'TDSPRAS' OF STRUCTURE es_form-header TO FIELD-SYMBOL(<lv_lang>).
      IF sy-subrc = 0 AND <lv_lang> IS NOT INITIAL AND <lv_lang> <> iv_spras.
        ev_found = abap_false.
      ENDIF.
    ENDIF.
  ENDMETHOD.


  METHOD read_std_text.
    DATA lv_object TYPE thead-tdobject VALUE 'TEXT'.
    DATA lv_tdname TYPE tdobname.
    DATA lv_tdid   TYPE tdid.

    CLEAR: ev_found, es_header, et_lines.
    split_text_name( EXPORTING iv_name = iv_name IMPORTING ev_tdname = lv_tdname ev_tdid = lv_tdid ).

    CALL FUNCTION 'READ_TEXT'
      EXPORTING
        client                  = sy-mandt
        id                      = lv_tdid
        language                = iv_spras
        name                    = lv_tdname
        object                  = lv_object
      IMPORTING
        header                  = es_header
      TABLES
        lines                   = et_lines
      EXCEPTIONS
        id                      = 1
        language                = 2
        name                    = 3
        not_found               = 4
        object                  = 5
        reference_check         = 6
        wrong_access_to_archive = 7
        OTHERS                  = 8.
    ev_found = xsdbool( sy-subrc = 0 ).
  ENDMETHOD.


  METHOD get_lines.
    DATA ls_form TYPE ty_form.
    DATA ls_head TYPE thead.

    CLEAR: ev_found, et_lines.
    CASE iv_object.
      WHEN 'FORM'.
        read_form( EXPORTING iv_form = iv_name iv_spras = iv_spras IMPORTING ev_found = ev_found es_form = ls_form ).
        et_lines = ls_form-lines.
      WHEN 'TEXT'.
        read_std_text( EXPORTING iv_name = iv_name iv_spras = iv_spras
                       IMPORTING ev_found = ev_found es_header = ls_head et_lines = et_lines ).
    ENDCASE.
  ENDMETHOD.


  METHOD segments.
    DATA ls_seg    TYPE ty_seg.
    DATA lv_window TYPE string.
    DATA lv_no     TYPE i.

    LOOP AT it_lines INTO DATA(ls_line).
      DATA(lv_fmt) = ls_line-tdformat.
      DATA(lv_txt) = CONV string( ls_line-tdline ).

      " Structure line: command /:, comment /*, window /W, text element /E ...
      " ('/ ' = new line and '/(' = raw new line are text, see below)
      IF lv_fmt(1) = '/' AND lv_fmt <> '/' AND lv_fmt <> '/('.
        IF ls_seg IS NOT INITIAL.
          APPEND ls_seg TO rt_seg.
          CLEAR ls_seg.
        ENDIF.
        IF lv_fmt = '/W'.
          lv_window = condense( lv_txt ).
        ENDIF.
        APPEND VALUE #( kind = 'K' window = lv_window lines = VALUE #( ( ls_line ) ) ) TO rt_seg.
        CONTINUE.
      ENDIF.

      " Continuation: ' ' = continuous text (joined with a blank), '=' / '(' = joined directly
      IF ls_seg IS NOT INITIAL AND ( lv_fmt = space OR lv_fmt = '=' OR lv_fmt = '(' ).
        IF lv_fmt = space.
          ls_seg-text = |{ ls_seg-text } { lv_txt }|.
        ELSE.
          ls_seg-text = ls_seg-text && lv_txt.
        ENDIF.
        APPEND ls_line TO ls_seg-lines.
        CONTINUE.
      ENDIF.

      " New paragraph or new line
      IF ls_seg IS NOT INITIAL.
        APPEND ls_seg TO rt_seg.
      ENDIF.
      ls_seg = VALUE #( kind     = 'T'
                        window   = lv_window
                        format   = lv_fmt
                        texttype = condense( CONV string( lv_fmt ) )
                        text     = lv_txt
                        lines    = VALUE #( ( ls_line ) ) ).
    ENDLOOP.
    IF ls_seg IS NOT INITIAL.
      APPEND ls_seg TO rt_seg.
    ENDIF.

    " Only paragraphs with real words are translated; numbering = stable text key
    LOOP AT rt_seg ASSIGNING FIELD-SYMBOL(<ls_seg>) WHERE kind = 'T'.
      IF has_words( <ls_seg>-text ) = abap_false.
        <ls_seg>-kind = 'K'.
        CONTINUE.
      ENDIF.
      lv_no = lv_no + 1.
      <ls_seg>-textkey = COND #( WHEN <ls_seg>-window IS INITIAL
                                 THEN |{ lv_no WIDTH = 4 ALIGN = RIGHT PAD = '0' }|
                                 ELSE |{ <ls_seg>-window }/{ lv_no WIDTH = 4 ALIGN = RIGHT PAD = '0' }| ).
    ENDLOOP.
  ENDMETHOD.


  METHOD has_words.
    " remove symbols &VBDKA-VBELN&, character formats <B> </> and tabs ,,
    DATA(lv_text) = replace( val = iv_text regex = `&[^&]*&` with = `` occ = 0 ).
    lv_text = replace( val = lv_text regex = `<[^<>]{0,3}>` with = `` occ = 0 ).
    lv_text = replace( val = lv_text sub = `,,` with = `` occ = 0 ).
    rv_yes = xsdbool( find( val = lv_text regex = `[[:alpha:]]` ) >= 0 ).
  ENDMETHOD.


  METHOD rebuild.
    LOOP AT it_seg INTO DATA(ls_seg).
      IF ls_seg-kind = 'T'.
        APPEND LINES OF wrap( iv_text = ls_seg-text iv_format = ls_seg-format ) TO rt_lines.
      ELSE.
        APPEND LINES OF ls_seg-lines TO rt_lines.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.


  METHOD wrap.
    DATA lv_rest TYPE string.
    DATA lv_fmt  TYPE tdformat.
    DATA lv_next TYPE tdformat.
    DATA lv_cut  TYPE i.
    DATA lv_pos  TYPE i.
    DATA lv_skip TYPE i.

    lv_rest = iv_text.
    lv_fmt  = iv_format.

    WHILE strlen( lv_rest ) > c_line_len.
      " 1) last blank within the line that is not inside a symbol &...&
      CLEAR lv_cut.
      lv_pos = c_line_len.
      WHILE lv_pos > 0.
        IF substring( val = lv_rest off = lv_pos len = 1 ) = ` `
           AND count( val = substring( val = lv_rest len = lv_pos ) sub = `&` ) MOD 2 = 0.
          lv_cut = lv_pos.
          EXIT.
        ENDIF.
        lv_pos = lv_pos - 1.
      ENDWHILE.

      IF lv_cut > 0.
        lv_next = space.            " continuous text: SAPscript adds the blank again
        lv_skip = 1.
      ELSE.
        " 2) no blank: hard cut ('=' joins without blank), not inside a symbol
        lv_cut = c_line_len.
        WHILE lv_cut > 1 AND count( val = substring( val = lv_rest len = lv_cut ) sub = `&` ) MOD 2 = 1.
          lv_cut = lv_cut - 1.
        ENDWHILE.
        IF lv_cut <= 1.
          lv_cut = c_line_len.
        ENDIF.
        lv_next = '='.
        lv_skip = 0.
      ENDIF.

      APPEND VALUE #( tdformat = lv_fmt tdline = substring( val = lv_rest len = lv_cut ) ) TO rt_lines.
      lv_rest = substring( val = lv_rest off = lv_cut + lv_skip ).
      lv_fmt  = lv_next.
    ENDWHILE.

    APPEND VALUE #( tdformat = lv_fmt tdline = lv_rest ) TO rt_lines.
  ENDMETHOD.


  METHOD same_structure.
    DATA(lv_a) = REDUCE string( INIT s = `` FOR a IN it_a WHERE ( kind = 'T' ) NEXT s = s && a-textkey && `|` ).
    DATA(lv_b) = REDUCE string( INIT s = `` FOR b IN it_b WHERE ( kind = 'T' ) NEXT s = s && b-textkey && `|` ).
    rv_yes = xsdbool( lv_a = lv_b ).
  ENDMETHOD.


  METHOD read_pairs.
    DATA lt_src   TYPE tt_tline.
    DATA lt_tgt   TYPE tt_tline.
    DATA lv_s_ok  TYPE abap_bool.
    DATA lv_t_ok  TYPE abap_bool.
    DATA lt_t_seg TYPE tt_seg.

    CLEAR: et_pairs, et_messages.

    get_lines( EXPORTING iv_object = iv_object iv_name = iv_name iv_spras = iv_s_lang
               IMPORTING ev_found = lv_s_ok et_lines = lt_src ).
    IF lv_s_ok = abap_false.
      APPEND |{ iv_object } { iv_name }: no text in source language { iv_s_lang } (client { sy-mandt })| TO et_messages.
      RETURN.
    ENDIF.

    get_lines( EXPORTING iv_object = iv_object iv_name = iv_name iv_spras = iv_t_lang
               IMPORTING ev_found = lv_t_ok et_lines = lt_tgt ).

    DATA(lt_s_seg) = segments( lt_src ).
    IF lv_t_ok = abap_true.
      lt_t_seg = segments( lt_tgt ).
      IF same_structure( it_a = lt_s_seg it_b = lt_t_seg ) = abap_false.
        APPEND |{ iv_object } { iv_name }: existing { iv_t_lang } version has other paragraphs than the source - | &&
               |it is not shown and will be replaced on upload| TO et_messages.
        CLEAR lt_t_seg.
      ENDIF.
    ENDIF.

    LOOP AT lt_s_seg INTO DATA(ls_seg) WHERE kind = 'T'.
      APPEND VALUE #( textkey = ls_seg-textkey texttype = ls_seg-texttype source = ls_seg-text ) TO et_pairs
        ASSIGNING FIELD-SYMBOL(<ls_pair>).
      READ TABLE lt_t_seg INTO DATA(ls_t) WITH KEY kind = 'T' textkey = ls_seg-textkey.
      IF sy-subrc = 0.
        <ls_pair>-target = ls_t-text.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.


  METHOD write_pairs.
    DATA lt_src     TYPE tt_tline.
    DATA lt_tgt     TYPE tt_tline.
    DATA lv_s_ok    TYPE abap_bool.
    DATA lv_t_ok    TYPE abap_bool.
    DATA lt_t_seg   TYPE tt_seg.
    DATA lv_changed TYPE abap_bool.
    DATA lv_open    TYPE i.
    DATA lt_new     TYPE tt_tline.

    CLEAR: et_results, es_e071, et_messages.

    get_lines( EXPORTING iv_object = iv_object iv_name = iv_name iv_spras = iv_s_lang
               IMPORTING ev_found = lv_s_ok et_lines = lt_src ).
    IF lv_s_ok = abap_false.
      RAISE EXCEPTION TYPE zcx_mcp_transl
        EXPORTING iv_text = |{ iv_object } { iv_name }: no text in source language { iv_s_lang }|.
    ENDIF.
    get_lines( EXPORTING iv_object = iv_object iv_name = iv_name iv_spras = iv_t_lang
               IMPORTING ev_found = lv_t_ok et_lines = lt_tgt ).

    DATA(lt_seg) = segments( lt_src ).
    IF lv_t_ok = abap_true.
      lt_t_seg = segments( lt_tgt ).
      IF same_structure( it_a = lt_seg it_b = lt_t_seg ) = abap_false.
        CLEAR lt_t_seg.
      ENDIF.
    ENDIF.

    " 1) existing translation as default for every paragraph
    LOOP AT lt_seg ASSIGNING FIELD-SYMBOL(<ls_seg>) WHERE kind = 'T'.
      READ TABLE lt_t_seg INTO DATA(ls_t) WITH KEY kind = 'T' textkey = <ls_seg>-textkey.
      IF sy-subrc = 0 AND ls_t-text IS NOT INITIAL.
        <ls_seg>-text = ls_t-text.
        <ls_seg>-done = abap_true.
      ENDIF.
    ENDLOOP.

    " 2) proposals
    LOOP AT it_pairs INTO DATA(ls_pair).
      READ TABLE lt_seg ASSIGNING <ls_seg> WITH KEY kind = 'T' textkey = ls_pair-textkey.
      IF sy-subrc <> 0.
        APPEND VALUE #( textkey = ls_pair-textkey result = `error`
                        message = `Paragraph not found - source text changed? Download again.` ) TO et_results.
        CONTINUE.
      ENDIF.
      IF ls_pair-target IS INITIAL.
        APPEND VALUE #( textkey = ls_pair-textkey result = `skipped` message = `Empty target text` ) TO et_results.
        CONTINUE.
      ENDIF.
      IF <ls_seg>-done = abap_true AND <ls_seg>-text = ls_pair-target.
        APPEND VALUE #( textkey = ls_pair-textkey result = `unchanged` ) TO et_results.
        CONTINUE.
      ENDIF.
      <ls_seg>-text = ls_pair-target.
      <ls_seg>-done = abap_true.
      lv_changed    = abap_true.
      APPEND VALUE #( textkey = ls_pair-textkey
                      result  = COND #( WHEN iv_dry_run = abap_true THEN `dry_run` ELSE `ok` ) ) TO et_results.
    ENDLOOP.

    lv_open = REDUCE i( INIT n = 0 FOR s IN lt_seg WHERE ( kind = 'T' AND done = abap_false ) NEXT n = n + 1 ).
    IF lv_open > 0.
      APPEND |{ iv_object } { iv_name }: { lv_open } paragraph(s) have no translation and stay in the source language| TO et_messages.
    ENDIF.

    IF lv_changed = abap_false OR iv_dry_run = abap_true.
      RETURN.
    ENDIF.

    lt_new = rebuild( lt_seg ).

    CASE iv_object.
      WHEN 'FORM'.
        DATA ls_base TYPE ty_form.
        " keep the layout of an existing translation (e.g. other fonts), otherwise copy the source
        read_form( EXPORTING iv_form = iv_name iv_spras = COND #( WHEN lv_t_ok = abap_true THEN iv_t_lang ELSE iv_s_lang )
                   IMPORTING es_form = ls_base ).
        ls_base-lines = lt_new.
        ASSIGN COMPONENT 'TDSPRAS' OF STRUCTURE ls_base-header TO FIELD-SYMBOL(<lv_spras>).
        IF sy-subrc = 0.
          <lv_spras> = iv_t_lang.
        ENDIF.

        TRY.
            CALL FUNCTION 'SAVE_FORM'
              EXPORTING
                form_header  = ls_base-header
              TABLES
                form_lines   = ls_base-lines
                pages        = ls_base-pages
                page_windows = ls_base-page_windows
                paragraphs   = ls_base-paragraphs
                strings      = ls_base-strings
                tabs         = ls_base-tabs
                windows      = ls_base-windows
              EXCEPTIONS
                OTHERS       = 1.
            DATA(lv_rc) = sy-subrc.
          CATCH cx_sy_dyn_call_error INTO DATA(lx_call).
            lv_rc = 9.
            APPEND |SAVE_FORM: { lx_call->get_text( ) }| TO et_messages.
        ENDTRY.

        IF lv_rc = 0 AND has_language( iv_object = iv_object iv_name = iv_name iv_spras = iv_t_lang ) = abap_false.
          lv_rc = 8.
        ENDIF.
        IF lv_rc <> 0.
          LOOP AT et_results ASSIGNING FIELD-SYMBOL(<ls_res>) WHERE result = `ok`.
            <ls_res>-result  = `error`.
            <ls_res>-message = |SAVE_FORM failed (rc={ lv_rc })|.
          ENDLOOP.
          RETURN.
        ENDIF.
        APPEND |FORM { iv_name }: language { iv_t_lang } saved. Check in SE71 that the version is active.| TO et_messages.
        es_e071 = VALUE #( pgmid = 'LANG' object = 'FORM' obj_name = to_upper( iv_name ) lang = iv_t_lang ).

      WHEN 'TEXT'.
        DATA ls_head  TYPE thead.
        DATA lt_dummy TYPE tt_tline.
        DATA lv_tdname TYPE tdobname.
        DATA lv_tdid   TYPE tdid.

        " header: from the existing translation, otherwise a copy of the source header
        read_std_text( EXPORTING iv_name = iv_name iv_spras = COND #( WHEN lv_t_ok = abap_true THEN iv_t_lang ELSE iv_s_lang )
                       IMPORTING es_header = ls_head et_lines = lt_dummy ).
        IF ls_head-tdospras IS INITIAL.
          ls_head-tdospras = iv_s_lang.
        ENDIF.
        ls_head-tdspras = iv_t_lang.
        DATA(lv_insert) = xsdbool( lv_t_ok = abap_false ).

        CALL FUNCTION 'SAVE_TEXT'
          EXPORTING
            client          = sy-mandt
            header          = ls_head
            insert          = lv_insert
            savemode_direct = abap_true
          TABLES
            lines           = lt_new
          EXCEPTIONS
            id              = 1
            language        = 2
            name            = 3
            object          = 4
            OTHERS          = 5.
        IF sy-subrc <> 0.
          DATA(lv_rc_text) = sy-subrc.
          LOOP AT et_results ASSIGNING <ls_res> WHERE result = `ok`.
            <ls_res>-result  = `error`.
            <ls_res>-message = |SAVE_TEXT failed (rc={ lv_rc_text })|.
          ENDLOOP.
          RETURN.
        ENDIF.

        split_text_name( EXPORTING iv_name = iv_name IMPORTING ev_tdname = lv_tdname ev_tdid = lv_tdid ).
        es_e071 = VALUE #( pgmid = 'R3TR' object = 'TEXT' obj_name = |TEXT,{ lv_tdname },{ lv_tdid },{ iv_t_lang }| ).
    ENDCASE.
  ENDMETHOD.

ENDCLASS.
