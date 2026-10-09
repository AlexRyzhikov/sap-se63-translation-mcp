"! Translation API behind the MCP server.
"! Wraps the LXE translation API that transaction SE63 uses internally:
"!   LXE_T002_CHECK_LANGUAGE        R/3 language  -> LXE language (e.g. D -> deDE)
"!   LXE_OBJ_EXPAND_TRANSPORT_OBJ   R3TR object   -> SE63 translation objects
"!   LXE_OBJ_TRANSLATION_STATUS2    status of one translation object
"!   LXE_OBJ_TEXT_PAIR_READ/WRITE   read / write text pairs (source + target)
"!   LXE_OBJ_CREATE_TRANSPORT_ENTRY transport entries for written translations
"!
"! Actions (called by ZCL_MCP_TRANSL_HTTP):
"!   ping | list_objects | status | read_texts | write_texts
CLASS zcl_mcp_transl_api DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    TYPES:
      BEGIN OF ty_r3tr_obj,
        pgmid    TYPE pgmid,
        object   TYPE trobjtype,
        obj_name TYPE sobj_name,
        devclass TYPE devclass,
      END OF ty_r3tr_obj,
      tt_r3tr_obj TYPE STANDARD TABLE OF ty_r3tr_obj WITH EMPTY KEY,

      BEGIN OF ty_lxe_obj,
        pgmid     TYPE pgmid,
        object    TYPE trobjtype,
        obj_name  TYPE sobj_name,
        custmnr   TYPE lxe_colob-custmnr,
        objtype   TYPE lxe_colob-objtype,
        objname   TYPE lxe_colob-objname,
        orig_lang TYPE lxe_colob-orig_lang,
      END OF ty_lxe_obj,
      tt_lxe_obj TYPE STANDARD TABLE OF ty_lxe_obj WITH EMPTY KEY,

      "! One text pair. Same structure for read (output) and write (input).
      BEGIN OF ty_text,
        object      TYPE trobjtype,
        obj_name    TYPE sobj_name,
        custmnr     TYPE lxe_colob-custmnr,
        objtype     TYPE lxe_colob-objtype,
        objname     TYPE lxe_colob-objname,
        source_lang TYPE string,
        target_lang TYPE string,
        textkey     TYPE lxe_pcx_s1-textkey,
        texttype    TYPE lxe_pcx_s1-texttype,
        max_len     TYPE i,
        uppcase     TYPE string,
        source      TYPE string,
        target      TYPE string,
      END OF ty_text,
      tt_text TYPE STANDARD TABLE OF ty_text WITH EMPTY KEY,

      tt_objtype TYPE STANDARD TABLE OF trobjtype WITH EMPTY KEY,

      BEGIN OF ty_request,
        package_name        TYPE devclass,
        include_subpackages TYPE abap_bool,
        transport           TYPE trkorr,
        object_types        TYPE tt_objtype,
        objects             TYPE tt_r3tr_obj,
        source_lang         TYPE string,
        target_lang         TYPE string,
        target_langs        TYPE string_table,
        only_missing        TYPE abap_bool,
        max_texts           TYPE i,
        dry_run             TYPE abap_bool,
        no_transport        TYPE abap_bool,
        texts               TYPE tt_text,
      END OF ty_request.

    METHODS handle
      IMPORTING
        iv_action      TYPE string
        iv_body        TYPE string
      RETURNING
        VALUE(rv_json) TYPE string
      RAISING
        zcx_mcp_transl.

  PROTECTED SECTION.
  PRIVATE SECTION.
    TYPES:
      BEGIN OF ty_ping,
        system      TYPE sysysid,
        client      TYPE symandt,
        user        TYPE syuname,
        release     TYPE sysaprl,
        logon_lang  TYPE string,
        lxe_lang    TYPE string,
        server_time TYPE string,
      END OF ty_ping,

      BEGIN OF ty_list_resp,
        count   TYPE i,
        objects TYPE tt_r3tr_obj,
      END OF ty_list_resp,

      BEGIN OF ty_status,
        object      TYPE trobjtype,
        obj_name    TYPE sobj_name,
        objtype     TYPE lxe_colob-objtype,
        objname     TYPE lxe_colob-objname,
        source_lang TYPE string,
        target_lang TYPE string,
        status      TYPE string,
        translated  TYPE abap_bool,
      END OF ty_status,
      tt_status TYPE STANDARD TABLE OF ty_status WITH EMPTY KEY,

      BEGIN OF ty_status_resp,
        count    TYPE i,
        status   TYPE tt_status,
        messages TYPE string_table,
      END OF ty_status_resp,

      BEGIN OF ty_read_resp,
        object_count TYPE i,
        text_count   TYPE i,
        truncated    TYPE abap_bool,
        texts        TYPE tt_text,
        messages     TYPE string_table,
      END OF ty_read_resp,

      BEGIN OF ty_write_result,
        objtype TYPE lxe_colob-objtype,
        objname TYPE lxe_colob-objname,
        textkey TYPE lxe_pcx_s1-textkey,
        result  TYPE string,
        message TYPE string,
      END OF ty_write_result,
      tt_write_result TYPE STANDARD TABLE OF ty_write_result WITH EMPTY KEY,

      BEGIN OF ty_write_resp,
        dry_run   TYPE abap_bool,
        written   TYPE i,
        errors    TYPE i,
        task      TYPE trkorr,
        results   TYPE tt_write_result,
        messages  TYPE string_table,
      END OF ty_write_resp.

    METHODS to_json
      IMPORTING ia_data        TYPE any
      RETURNING VALUE(rv_json) TYPE string.

    METHODS ping
      RETURNING VALUE(rs_ping) TYPE ty_ping
      RAISING   zcx_mcp_transl.

    METHODS list_objects
      IMPORTING is_req            TYPE ty_request
      RETURNING VALUE(rt_objects) TYPE tt_r3tr_obj
      RAISING   zcx_mcp_transl.

    METHODS expand
      IMPORTING it_objects    TYPE tt_r3tr_obj
      EXPORTING et_lxe        TYPE tt_lxe_obj
      CHANGING  ct_messages   TYPE string_table.

    METHODS get_status
      IMPORTING is_req         TYPE ty_request
      RETURNING VALUE(rs_resp) TYPE ty_status_resp
      RAISING   zcx_mcp_transl.

    METHODS read_texts
      IMPORTING is_req         TYPE ty_request
      RETURNING VALUE(rs_resp) TYPE ty_read_resp
      RAISING   zcx_mcp_transl.

    METHODS write_texts
      IMPORTING is_req         TYPE ty_request
      RETURNING VALUE(rs_resp) TYPE ty_write_resp
      RAISING   zcx_mcp_transl.

    METHODS to_lxe_lang
      IMPORTING iv_lang        TYPE string
      RETURNING VALUE(rv_lang) TYPE lxeisolang
      RAISING   zcx_mcp_transl.

    METHODS source_lang_for
      IMPORTING is_req         TYPE ty_request
                is_obj         TYPE ty_lxe_obj
      RETURNING VALUE(rv_lang) TYPE lxeisolang
      RAISING   zcx_mcp_transl.

    METHODS find_task
      IMPORTING iv_transport   TYPE trkorr
      RETURNING VALUE(rv_task) TYPE trkorr
      RAISING   zcx_mcp_transl.

ENDCLASS.



CLASS zcl_mcp_transl_api IMPLEMENTATION.

  METHOD handle.
    DATA ls_req TYPE ty_request.

    IF iv_body IS NOT INITIAL.
      /ui2/cl_json=>deserialize(
        EXPORTING json        = iv_body
                  pretty_name = /ui2/cl_json=>pretty_mode-low_case
        CHANGING  data        = ls_req ).
    ENDIF.

    CASE iv_action.
      WHEN `ping`.
        rv_json = to_json( ping( ) ).

      WHEN `list_objects`.
        DATA(lt_objects) = list_objects( ls_req ).
        rv_json = to_json( VALUE ty_list_resp( count = lines( lt_objects ) objects = lt_objects ) ).

      WHEN `status`.
        rv_json = to_json( get_status( ls_req ) ).

      WHEN `read_texts`.
        rv_json = to_json( read_texts( ls_req ) ).

      WHEN `write_texts`.
        rv_json = to_json( write_texts( ls_req ) ).

      WHEN OTHERS.
        RAISE EXCEPTION TYPE zcx_mcp_transl
          EXPORTING iv_text        = |Unknown action '{ iv_action }'. Use ping, list_objects, status, read_texts, write_texts.|
                    iv_http_status = 404.
    ENDCASE.
  ENDMETHOD.


  METHOD to_json.
    rv_json = /ui2/cl_json=>serialize(
                data        = ia_data
                pretty_name = /ui2/cl_json=>pretty_mode-low_case ).
  ENDMETHOD.


  METHOD ping.
    DATA lv_ts TYPE timestampl.
    GET TIME STAMP FIELD lv_ts.
    rs_ping = VALUE #(
      system      = sy-sysid
      client      = sy-mandt
      user        = sy-uname
      release     = sy-saprl
      logon_lang  = CONV #( sy-langu )
      lxe_lang    = to_lxe_lang( CONV #( sy-langu ) )
      server_time = |{ lv_ts TIMESTAMP = ISO }| ).
  ENDMETHOD.


  METHOD list_objects.
    DATA lt_packages TYPE RANGE OF devclass.
    DATA lt_queue    TYPE STANDARD TABLE OF devclass WITH EMPTY KEY.
    DATA lt_children TYPE STANDARD TABLE OF devclass WITH EMPTY KEY.
    DATA lt_korr     TYPE RANGE OF trkorr.
    DATA lt_tasks    TYPE STANDARD TABLE OF trkorr WITH EMPTY KEY.
    DATA lv_package  TYPE devclass.
    DATA lv_r3_type  TYPE trobjtype.
    DATA lv_r3_name  TYPE trobj_name.
    DATA lt_types    TYPE RANGE OF trobjtype.

    IF is_req-package_name IS INITIAL AND is_req-transport IS INITIAL AND is_req-objects IS INITIAL.
      RAISE EXCEPTION TYPE zcx_mcp_transl
        EXPORTING iv_text = `Give package_name, transport or objects`.
    ENDIF.

    " 1) Objects of a package (optionally with sub-packages)
    IF is_req-package_name IS NOT INITIAL.
      lv_package = to_upper( is_req-package_name ).
      lt_packages = VALUE #( ( sign = 'I' option = 'EQ' low = lv_package ) ).

      IF is_req-include_subpackages = abap_true.
        lt_queue = VALUE #( ( lv_package ) ).
        WHILE lt_queue IS NOT INITIAL.
          DATA(lv_current) = lt_queue[ 1 ].
          DELETE lt_queue INDEX 1.
          CLEAR lt_children.
          SELECT devclass FROM tdevc
            WHERE parentcl = @lv_current
            INTO TABLE @lt_children.
          LOOP AT lt_children INTO DATA(lv_child).
            APPEND VALUE #( sign = 'I' option = 'EQ' low = lv_child ) TO lt_packages.
            APPEND lv_child TO lt_queue.
          ENDLOOP.
        ENDWHILE.
      ENDIF.

      SELECT pgmid, object, obj_name, devclass FROM tadir
        WHERE devclass IN @lt_packages
          AND pgmid    = 'R3TR'
          AND object  <> 'DEVC'
          AND delflag  = @space
        APPENDING CORRESPONDING FIELDS OF TABLE @rt_objects.
    ENDIF.

    " 2) Objects of a transport request (request + all its tasks)
    IF is_req-transport IS NOT INITIAL.
      DATA(lv_transport) = CONV trkorr( to_upper( is_req-transport ) ).
      lt_korr = VALUE #( ( sign = 'I' option = 'EQ' low = lv_transport ) ).
      SELECT trkorr FROM e070
        WHERE strkorr = @lv_transport
        INTO TABLE @lt_tasks.
      LOOP AT lt_tasks INTO DATA(lv_task).
        APPEND VALUE #( sign = 'I' option = 'EQ' low = lv_task ) TO lt_korr.
      ENDLOOP.

      SELECT DISTINCT pgmid, object, obj_name FROM e071
        WHERE trkorr IN @lt_korr
          AND pgmid  IN ('R3TR', 'LIMU')
        INTO TABLE @DATA(lt_e071).

      LOOP AT lt_e071 INTO DATA(ls_e071).
        IF ls_e071-pgmid = 'LIMU'.
          CLEAR: lv_r3_type, lv_r3_name.
          CALL FUNCTION 'GET_R3TR_OBJECT_FROM_LIMU_OBJ'
            EXPORTING
              p_limu_objtype = ls_e071-object
              p_limu_objname = ls_e071-obj_name
            IMPORTING
              p_r3tr_objtype = lv_r3_type
              p_r3tr_objname = lv_r3_name
            EXCEPTIONS
              no_mapping     = 1
              OTHERS         = 2.
          IF sy-subrc <> 0.
            CONTINUE.
          ENDIF.
          APPEND VALUE #( pgmid = 'R3TR' object = lv_r3_type obj_name = lv_r3_name ) TO rt_objects.
        ELSE.
          APPEND VALUE #( pgmid = 'R3TR' object = ls_e071-object obj_name = ls_e071-obj_name ) TO rt_objects.
        ENDIF.
      ENDLOOP.
    ENDIF.

    " 3) Explicit objects
    LOOP AT is_req-objects INTO DATA(ls_obj).
      APPEND VALUE #( pgmid    = COND #( WHEN ls_obj-pgmid IS INITIAL THEN 'R3TR' ELSE to_upper( ls_obj-pgmid ) )
                      object   = to_upper( ls_obj-object )
                      obj_name = to_upper( ls_obj-obj_name ) ) TO rt_objects.
    ENDLOOP.

    " Filter by object type
    IF is_req-object_types IS NOT INITIAL.
      lt_types = VALUE #( FOR t IN is_req-object_types ( sign = 'I' option = 'EQ' low = to_upper( t ) ) ).
      DELETE rt_objects WHERE object NOT IN lt_types.
    ENDIF.

    SORT rt_objects BY pgmid object obj_name.
    DELETE ADJACENT DUPLICATES FROM rt_objects COMPARING pgmid object obj_name.

    " Fill package where missing
    LOOP AT rt_objects ASSIGNING FIELD-SYMBOL(<ls_obj>) WHERE devclass IS INITIAL.
      SELECT SINGLE devclass FROM tadir
        WHERE pgmid = @<ls_obj>-pgmid AND object = @<ls_obj>-object AND obj_name = @<ls_obj>-obj_name
        INTO @<ls_obj>-devclass.
    ENDLOOP.
  ENDMETHOD.


  METHOD expand.
    DATA lt_colob   TYPE STANDARD TABLE OF lxe_colob.
    DATA lv_objname TYPE trobj_name.

    CLEAR et_lxe.
    LOOP AT it_objects INTO DATA(ls_obj).
      CLEAR lt_colob.
      lv_objname = ls_obj-obj_name.
      CALL FUNCTION 'LXE_OBJ_EXPAND_TRANSPORT_OBJ'
        EXPORTING
          pgmid           = ls_obj-pgmid
          object          = ls_obj-object
          obj_name        = lv_objname
        TABLES
          ex_colob        = lt_colob
        EXCEPTIONS
          unknown_object  = 1
          unknown_ta_type = 2
          OTHERS          = 3.
      IF sy-subrc <> 0.
        APPEND |{ ls_obj-object } { ls_obj-obj_name }: not translatable (expand rc={ sy-subrc })| TO ct_messages.
        CONTINUE.
      ENDIF.

      LOOP AT lt_colob INTO DATA(ls_colob).
        APPEND VALUE #( pgmid     = ls_obj-pgmid
                        object    = ls_obj-object
                        obj_name  = ls_obj-obj_name
                        custmnr   = ls_colob-custmnr
                        objtype   = ls_colob-objtype
                        objname   = ls_colob-objname
                        orig_lang = ls_colob-orig_lang ) TO et_lxe.
      ENDLOOP.
    ENDLOOP.

    SORT et_lxe BY custmnr objtype objname.
    DELETE ADJACENT DUPLICATES FROM et_lxe COMPARING custmnr objtype objname.
  ENDMETHOD.


  METHOD get_status.
    DATA lt_lxe     TYPE tt_lxe_obj.
    DATA lv_stattrn TYPE lxestattrn.
    DATA lt_langs   TYPE string_table.

    lt_langs = is_req-target_langs.
    IF is_req-target_lang IS NOT INITIAL.
      APPEND is_req-target_lang TO lt_langs.
    ENDIF.
    IF lt_langs IS INITIAL.
      RAISE EXCEPTION TYPE zcx_mcp_transl EXPORTING iv_text = `Give target_lang or target_langs`.
    ENDIF.

    expand( EXPORTING it_objects = list_objects( is_req )
            IMPORTING et_lxe     = lt_lxe
            CHANGING  ct_messages = rs_resp-messages ).

    LOOP AT lt_langs INTO DATA(lv_lang).
      DATA(lv_t_lang) = to_lxe_lang( lv_lang ).
      LOOP AT lt_lxe INTO DATA(ls_lxe).
        DATA(lv_s_lang) = source_lang_for( is_req = is_req is_obj = ls_lxe ).
        IF lv_s_lang IS INITIAL.
          APPEND |{ ls_lxe-objtype } { ls_lxe-objname }: original language unknown, give source_lang| TO rs_resp-messages.
          CONTINUE.
        ENDIF.
        IF lv_s_lang = lv_t_lang.
          CONTINUE.
        ENDIF.

        CLEAR lv_stattrn.
        CALL FUNCTION 'LXE_OBJ_TRANSLATION_STATUS2'
          EXPORTING
            t_lang  = lv_t_lang
            s_lang  = lv_s_lang
            custmnr = ls_lxe-custmnr
            objtype = ls_lxe-objtype
            objname = ls_lxe-objname
          IMPORTING
            stattrn = lv_stattrn
          EXCEPTIONS
            OTHERS  = 1.
        IF sy-subrc <> 0.
          APPEND |{ ls_lxe-objtype } { ls_lxe-objname }: status not readable| TO rs_resp-messages.
          CONTINUE.
        ENDIF.

        APPEND VALUE #( object      = ls_lxe-object
                        obj_name    = ls_lxe-obj_name
                        objtype     = ls_lxe-objtype
                        objname     = ls_lxe-objname
                        source_lang = CONV #( lv_s_lang )
                        target_lang = CONV #( lv_t_lang )
                        status      = CONV #( lv_stattrn )
                        translated  = xsdbool( lv_stattrn = 'T' ) ) TO rs_resp-status.
      ENDLOOP.
    ENDLOOP.

    rs_resp-count = lines( rs_resp-status ).
  ENDMETHOD.


  METHOD read_texts.
    DATA lt_lxe   TYPE tt_lxe_obj.
    DATA lt_pairs TYPE STANDARD TABLE OF lxe_pcx_s1.

    IF is_req-target_lang IS INITIAL.
      RAISE EXCEPTION TYPE zcx_mcp_transl EXPORTING iv_text = `Give target_lang`.
    ENDIF.
    DATA(lv_t_lang) = to_lxe_lang( is_req-target_lang ).

    expand( EXPORTING it_objects = list_objects( is_req )
            IMPORTING et_lxe     = lt_lxe
            CHANGING  ct_messages = rs_resp-messages ).
    rs_resp-object_count = lines( lt_lxe ).

    LOOP AT lt_lxe INTO DATA(ls_lxe).
      DATA(lv_s_lang) = source_lang_for( is_req = is_req is_obj = ls_lxe ).
      IF lv_s_lang IS INITIAL.
        APPEND |{ ls_lxe-objtype } { ls_lxe-objname }: original language unknown, give source_lang| TO rs_resp-messages.
        CONTINUE.
      ENDIF.
      IF lv_s_lang = lv_t_lang.
        CONTINUE. " object is maintained in the target language itself
      ENDIF.

      CLEAR lt_pairs.
      CALL FUNCTION 'LXE_OBJ_TEXT_PAIR_READ'
        EXPORTING
          t_lang    = lv_t_lang
          s_lang    = lv_s_lang
          custmnr   = ls_lxe-custmnr
          objtype   = ls_lxe-objtype
          objname   = ls_lxe-objname
          read_only = abap_true
        TABLES
          lt_pcx_s1 = lt_pairs
        EXCEPTIONS
          OTHERS    = 1.
      IF sy-subrc <> 0.
        APPEND |{ ls_lxe-objtype } { ls_lxe-objname }: text pairs not readable| TO rs_resp-messages.
        CONTINUE.
      ENDIF.

      LOOP AT lt_pairs INTO DATA(ls_pair).
        IF ls_pair-s_text IS INITIAL.
          CONTINUE.
        ENDIF.
        IF is_req-only_missing = abap_true AND ls_pair-t_text IS NOT INITIAL.
          CONTINUE.
        ENDIF.

        APPEND VALUE #( object      = ls_lxe-object
                        obj_name    = ls_lxe-obj_name
                        custmnr     = ls_lxe-custmnr
                        objtype     = ls_lxe-objtype
                        objname     = ls_lxe-objname
                        source_lang = CONV #( lv_s_lang )
                        target_lang = CONV #( lv_t_lang )
                        textkey     = ls_pair-textkey
                        texttype    = ls_pair-texttype
                        max_len     = ls_pair-unitmlt
                        uppcase     = CONV #( ls_pair-uppcase )
                        source      = CONV #( ls_pair-s_text )
                        target      = CONV #( ls_pair-t_text ) ) TO rs_resp-texts.

        IF is_req-max_texts > 0 AND lines( rs_resp-texts ) >= is_req-max_texts.
          rs_resp-truncated  = abap_true.
          rs_resp-text_count = lines( rs_resp-texts ).
          RETURN.
        ENDIF.
      ENDLOOP.
    ENDLOOP.

    rs_resp-text_count = lines( rs_resp-texts ).
  ENDMETHOD.


  METHOD write_texts.
    DATA lt_texts     TYPE tt_text.
    DATA lt_pairs     TYPE STANDARD TABLE OF lxe_pcx_s1.
    DATA lt_changed   TYPE STANDARD TABLE OF lxe_pcx_s1.
    DATA lt_e071      TYPE STANDARD TABLE OF e071.
    DATA lt_e071k     TYPE STANDARD TABLE OF e071k.
    DATA lt_e071_tmp  TYPE STANDARD TABLE OF e071.
    DATA lt_e071k_tmp TYPE STANDARD TABLE OF e071k.
    DATA lv_task      TYPE trkorr.
    DATA lv_s_lang    TYPE lxeisolang.
    DATA lv_t_lang    TYPE lxeisolang.

    rs_resp-dry_run = is_req-dry_run.

    IF is_req-texts IS INITIAL.
      RAISE EXCEPTION TYPE zcx_mcp_transl EXPORTING iv_text = `No texts given`.
    ENDIF.

    IF is_req-transport IS NOT INITIAL.
      lv_task = find_task( CONV #( to_upper( is_req-transport ) ) ).
      rs_resp-task = lv_task.
    ELSEIF is_req-no_transport = abap_false AND is_req-dry_run = abap_false.
      RAISE EXCEPTION TYPE zcx_mcp_transl
        EXPORTING iv_text = `Give a transport request, or set no_transport = true (local objects only)`.
    ENDIF.

    " Normalise languages (each text may carry its own; request values are the default)
    lt_texts = is_req-texts.
    LOOP AT lt_texts ASSIGNING FIELD-SYMBOL(<ls_text>).
      <ls_text>-source_lang = to_lxe_lang( COND #( WHEN <ls_text>-source_lang IS NOT INITIAL
                                                   THEN <ls_text>-source_lang ELSE is_req-source_lang ) ).
      <ls_text>-target_lang = to_lxe_lang( COND #( WHEN <ls_text>-target_lang IS NOT INITIAL
                                                   THEN <ls_text>-target_lang ELSE is_req-target_lang ) ).
    ENDLOOP.
    SORT lt_texts BY custmnr objtype objname source_lang target_lang textkey.

    LOOP AT lt_texts INTO DATA(ls_first)
         GROUP BY ( custmnr = ls_first-custmnr
                    objtype = ls_first-objtype
                    objname = ls_first-objname
                    s_lang  = ls_first-source_lang
                    t_lang  = ls_first-target_lang )
         INTO DATA(ls_group).

      lv_s_lang = ls_group-s_lang.
      lv_t_lang = ls_group-t_lang.

      CLEAR: lt_pairs, lt_changed.
      CALL FUNCTION 'LXE_OBJ_TEXT_PAIR_READ'
        EXPORTING
          t_lang    = lv_t_lang
          s_lang    = lv_s_lang
          custmnr   = ls_group-custmnr
          objtype   = ls_group-objtype
          objname   = ls_group-objname
          read_only = abap_false
        TABLES
          lt_pcx_s1 = lt_pairs
        EXCEPTIONS
          OTHERS    = 1.
      IF sy-subrc <> 0.
        LOOP AT GROUP ls_group INTO DATA(ls_err).
          APPEND VALUE #( objtype = ls_err-objtype objname = ls_err-objname textkey = ls_err-textkey
                          result = `error` message = `Object not readable / locked` ) TO rs_resp-results.
        ENDLOOP.
        CONTINUE.
      ENDIF.

      LOOP AT GROUP ls_group INTO DATA(ls_text).
        READ TABLE lt_pairs ASSIGNING FIELD-SYMBOL(<ls_pair>) WITH KEY textkey = ls_text-textkey.
        IF sy-subrc <> 0.
          APPEND VALUE #( objtype = ls_text-objtype objname = ls_text-objname textkey = ls_text-textkey
                          result = `error` message = `Text key not found in object` ) TO rs_resp-results.
          CONTINUE.
        ENDIF.

        IF ls_text-target IS INITIAL.
          APPEND VALUE #( objtype = ls_text-objtype objname = ls_text-objname textkey = ls_text-textkey
                          result = `skipped` message = `Empty target text` ) TO rs_resp-results.
          CONTINUE.
        ENDIF.

        IF <ls_pair>-unitmlt > 0 AND strlen( ls_text-target ) > <ls_pair>-unitmlt.
          APPEND VALUE #( objtype = ls_text-objtype objname = ls_text-objname textkey = ls_text-textkey
                          result  = `error`
                          message = |Too long: { strlen( ls_text-target ) } > max { <ls_pair>-unitmlt }| ) TO rs_resp-results.
          CONTINUE.
        ENDIF.

        IF CONV string( <ls_pair>-t_text ) = ls_text-target.
          APPEND VALUE #( objtype = ls_text-objtype objname = ls_text-objname textkey = ls_text-textkey
                          result = `unchanged` ) TO rs_resp-results.
          CONTINUE.
        ENDIF.

        <ls_pair>-t_text = ls_text-target.
        APPEND <ls_pair> TO lt_changed.
        APPEND VALUE #( objtype = ls_text-objtype objname = ls_text-objname textkey = ls_text-textkey
                        result = COND #( WHEN is_req-dry_run = abap_true THEN `dry_run` ELSE `ok` ) ) TO rs_resp-results.
      ENDLOOP.

      IF lt_changed IS INITIAL OR is_req-dry_run = abap_true.
        CONTINUE.
      ENDIF.

      CALL FUNCTION 'LXE_OBJ_TEXT_PAIR_WRITE'
        EXPORTING
          t_lang    = lv_t_lang
          s_lang    = lv_s_lang
          custmnr   = ls_group-custmnr
          objtype   = ls_group-objtype
          objname   = ls_group-objname
        TABLES
          lt_pcx_s1 = lt_changed
        EXCEPTIONS
          OTHERS    = 1.
      IF sy-subrc <> 0.
        LOOP AT rs_resp-results ASSIGNING FIELD-SYMBOL(<ls_res>)
             WHERE objtype = ls_group-objtype AND objname = ls_group-objname AND result = `ok`.
          <ls_res>-result  = `error`.
          <ls_res>-message = `LXE_OBJ_TEXT_PAIR_WRITE failed`.
        ENDLOOP.
        CONTINUE.
      ENDIF.

      IF lv_task IS NOT INITIAL.
        CLEAR: lt_e071_tmp, lt_e071k_tmp.
        CALL FUNCTION 'LXE_OBJ_CREATE_TRANSPORT_ENTRY'
          EXPORTING
            language = lv_t_lang
            custmnr  = ls_group-custmnr
            objtype  = ls_group-objtype
            objname  = ls_group-objname
            tabkey   = '*'
          TABLES
            ex_e071  = lt_e071_tmp
            ex_e071k = lt_e071k_tmp
          EXCEPTIONS
            OTHERS   = 1.
        IF sy-subrc = 0.
          APPEND LINES OF lt_e071_tmp TO lt_e071.
          APPEND LINES OF lt_e071k_tmp TO lt_e071k.
        ELSE.
          APPEND |{ ls_group-objtype } { ls_group-objname }: no transport entry created| TO rs_resp-messages.
        ENDIF.
      ENDIF.
    ENDLOOP.

    rs_resp-written = REDUCE i( INIT n = 0 FOR r IN rs_resp-results WHERE ( result = `ok` ) NEXT n = n + 1 ).
    rs_resp-errors  = REDUCE i( INIT n = 0 FOR r IN rs_resp-results WHERE ( result = `error` ) NEXT n = n + 1 ).

    IF is_req-dry_run = abap_true.
      RETURN.
    ENDIF.

    " Record translations in the transport task
    IF lt_e071 IS NOT INITIAL.
      LOOP AT lt_e071 ASSIGNING FIELD-SYMBOL(<ls_e071>).
        <ls_e071>-trkorr = lv_task.
      ENDLOOP.
      LOOP AT lt_e071k ASSIGNING FIELD-SYMBOL(<ls_e071k>).
        <ls_e071k>-trkorr = lv_task.
      ENDLOOP.
      SORT lt_e071 BY pgmid object obj_name.
      DELETE ADJACENT DUPLICATES FROM lt_e071 COMPARING pgmid object obj_name.

      CALL FUNCTION 'TRINT_APPEND_COMM'
        EXPORTING
          wi_exclusive       = abap_false
          wi_sel_e071        = abap_true
          wi_sel_e071k       = abap_true
          wi_trkorr          = lv_task
        TABLES
          wt_e071            = lt_e071
          wt_e071k           = lt_e071k
        EXCEPTIONS
          e071k_append_error = 1
          e071_append_error  = 2
          trkorr_empty       = 3
          OTHERS             = 4.
      IF sy-subrc <> 0.
        APPEND |Texts saved, but adding to task { lv_task } failed (rc={ sy-subrc }). Add them in SE63/SLXT.| TO rs_resp-messages.
      ELSE.
        CALL FUNCTION 'TR_SORT_AND_COMPRESS_COMM'
          EXPORTING
            iv_trkorr = lv_task
          EXCEPTIONS
            OTHERS    = 1.
        APPEND |{ lines( lt_e071 ) } transport entries added to task { lv_task }| TO rs_resp-messages.
      ENDIF.
    ENDIF.

    COMMIT WORK AND WAIT.
  ENDMETHOD.


  METHOD to_lxe_lang.
    DATA lv_spras TYPE spras.
    DATA lv_laiso TYPE laiso.
    DATA(lv_in) = condense( iv_lang ).

    CASE strlen( lv_in ).
      WHEN 4.                          " already LXE format, e.g. deDE / enUS
        rv_lang = lv_in.
        RETURN.
      WHEN 2.                          " ISO 639, e.g. DE / EN / KO
        lv_laiso = to_upper( lv_in ).
        CALL FUNCTION 'CONVERSION_EXIT_ISOLA_INPUT'
          EXPORTING
            input            = lv_laiso
          IMPORTING
            output           = lv_spras
          EXCEPTIONS
            unknown_language = 1
            OTHERS           = 2.
        IF sy-subrc <> 0.
          RAISE EXCEPTION TYPE zcx_mcp_transl EXPORTING iv_text = |Unknown language '{ lv_in }'|.
        ENDIF.
      WHEN 1.                          " SAP language key, e.g. D / E / 3
        lv_spras = lv_in.
      WHEN OTHERS.
        RAISE EXCEPTION TYPE zcx_mcp_transl
          EXPORTING iv_text = |Language '{ lv_in }': use ISO (DE), SAP key (D) or LXE (deDE)|.
    ENDCASE.

    CALL FUNCTION 'LXE_T002_CHECK_LANGUAGE'
      EXPORTING
        r3_lang            = lv_spras
      IMPORTING
        o_language         = rv_lang
      EXCEPTIONS
        language_not_in_cp = 1
        unknown            = 2
        OTHERS             = 3.
    IF sy-subrc <> 0 OR rv_lang IS INITIAL.
      RAISE EXCEPTION TYPE zcx_mcp_transl
        EXPORTING iv_text = |Language '{ lv_in }' is not a translation language in this system|.
    ENDIF.
  ENDMETHOD.


  METHOD source_lang_for.
    IF is_req-source_lang IS NOT INITIAL.
      rv_lang = to_lxe_lang( is_req-source_lang ).
    ELSE.
      rv_lang = is_obj-orig_lang.
    ENDIF.
  ENDMETHOD.


  METHOD find_task.
    SELECT SINGLE trkorr, trstatus, strkorr FROM e070
      WHERE trkorr = @iv_transport
      INTO @DATA(ls_e070).
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE zcx_mcp_transl EXPORTING iv_text = |Transport { iv_transport } not found|.
    ENDIF.
    IF ls_e070-trstatus <> 'D' AND ls_e070-trstatus <> 'L'.
      RAISE EXCEPTION TYPE zcx_mcp_transl EXPORTING iv_text = |Transport { iv_transport } is not modifiable|.
    ENDIF.

    IF ls_e070-strkorr IS NOT INITIAL.   " a task was given directly
      rv_task = iv_transport.
      RETURN.
    ENDIF.

    SELECT SINGLE trkorr FROM e070
      WHERE strkorr  = @iv_transport
        AND as4user  = @sy-uname
        AND trstatus IN ('D', 'L')
      INTO @rv_task.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE zcx_mcp_transl
        EXPORTING iv_text = |No modifiable task for user { sy-uname } in { iv_transport }. Create one in SE09.|.
    ENDIF.
  ENDMETHOD.

ENDCLASS.
